#!/usr/bin/env node
/**
 * Lightweight CLI client for agent-browser
 * 
 * This file contains ONLY the client logic (no Playwright imports).
 * It can be compiled with Bun for fast startup times.
 * 
 * The actual browser automation runs in a separate daemon process.
 */

import * as net from 'net';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';

// ============================================================================
// Configuration
// ============================================================================

const SESSION = process.env.AGENT_BROWSER_SESSION || 'default';
const SOCKET_PATH = path.join(os.tmpdir(), `agent-browser-${SESSION}.sock`);
const PID_FILE = path.join(os.tmpdir(), `agent-browser-${SESSION}.pid`);

// ============================================================================
// Daemon Management
// ============================================================================

function isDaemonRunning(): boolean {
  if (!fs.existsSync(PID_FILE)) return false;
  try {
    const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ensureDaemon(): Promise<void> {
  if (isDaemonRunning() && fs.existsSync(SOCKET_PATH)) {
    return;
  }

  // Find the daemon script - look relative to this script
  const scriptDir = path.dirname(process.argv[1]);
  let daemonPath = path.join(scriptDir, 'daemon.js');
  
  // Fallback paths
  if (!fs.existsSync(daemonPath)) {
    daemonPath = path.join(scriptDir, '../dist/daemon.js');
  }
  if (!fs.existsSync(daemonPath)) {
    daemonPath = path.join(process.cwd(), 'dist/daemon.js');
  }
  
  if (!fs.existsSync(daemonPath)) {
    throw new Error(`Daemon not found. Looked in: ${daemonPath}`);
  }

  const child = spawn('node', [daemonPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, AGENT_BROWSER_DAEMON: '1', AGENT_BROWSER_SESSION: SESSION },
  });
  child.unref();

  // Wait for socket
  for (let i = 0; i < 50; i++) {
    if (fs.existsSync(SOCKET_PATH)) return;
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error('Failed to start daemon');
}

// ============================================================================
// Command Execution
// ============================================================================

interface Response {
  id: string;
  success: boolean;
  data?: unknown;
  error?: string;
}

async function sendCommand(cmd: Record<string, unknown>): Promise<Response> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    let resolved = false;
    const socket = net.createConnection(SOCKET_PATH);

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.on('connect', () => {
      socket.write(JSON.stringify(cmd) + '\n');
    });

    socket.on('data', (data) => {
      buffer += data.toString();
      const idx = buffer.indexOf('\n');
      if (idx !== -1 && !resolved) {
        resolved = true;
        try {
          const response = JSON.parse(buffer.substring(0, idx)) as Response;
          cleanup();
          resolve(response);
        } catch {
          cleanup();
          reject(new Error('Invalid JSON response'));
        }
      }
    });

    socket.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(err);
      }
    });

    socket.on('close', () => {
      if (!resolved && buffer.trim()) {
        resolved = true;
        try {
          resolve(JSON.parse(buffer.trim()) as Response);
        } catch {
          reject(new Error('Connection closed'));
        }
      }
    });

    setTimeout(() => {
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error('Timeout'));
      }
    }, 30000);
  });
}

// ============================================================================
// Command Parsing
// ============================================================================

function parseCommand(parts: string[]): Record<string, unknown> | null {
  if (parts.length === 0) return null;
  
  const command = parts[0];
  const rest = parts.slice(1);
  const id = Math.random().toString(36).slice(2, 10);

  switch (command) {
    case 'open':
    case 'goto':
    case 'navigate':
      return { id, action: 'navigate', url: rest[0]?.startsWith('http') ? rest[0] : `https://${rest[0]}` };
    
    case 'click':
      return { id, action: 'click', selector: rest[0] };
    
    case 'fill':
      return { id, action: 'fill', selector: rest[0], value: rest.slice(1).join(' ') };
    
    case 'type':
      return { id, action: 'type', selector: rest[0], text: rest.slice(1).join(' ') };
    
    case 'hover':
      return { id, action: 'hover', selector: rest[0] };
    
    case 'snapshot': {
      const opts: Record<string, unknown> = { id, action: 'snapshot' };
      // Parse snapshot options from rest args
      for (let i = 0; i < rest.length; i++) {
        const arg = rest[i];
        if (arg === '-i' || arg === '--interactive') {
          opts.interactive = true;
        } else if (arg === '-c' || arg === '--compact') {
          opts.compact = true;
        } else if (arg === '--depth' || arg === '-d') {
          opts.maxDepth = parseInt(rest[++i], 10);
        } else if (arg === '--selector' || arg === '-s') {
          opts.selector = rest[++i];
        }
      }
      return opts;
    }
    
    case 'screenshot':
      return { id, action: 'screenshot', path: rest[0] };
    
    case 'close':
    case 'quit':
      return { id, action: 'close' };
    
    case 'get':
      if (rest[0] === 'text') return { id, action: 'gettext', selector: rest[1] };
      if (rest[0] === 'url') return { id, action: 'url' };
      if (rest[0] === 'title') return { id, action: 'title' };
      return null;
    
    case 'press':
      return { id, action: 'press', key: rest[0] };
    
    case 'wait':
      if (/^\d+$/.test(rest[0])) {
        return { id, action: 'wait', timeout: parseInt(rest[0], 10) };
      }
      return { id, action: 'wait', selector: rest[0] };
    
    case 'back':
      return { id, action: 'back' };
    
    case 'forward':
      return { id, action: 'forward' };
    
    case 'reload':
      return { id, action: 'reload' };
    
    case 'eval':
      return { id, action: 'evaluate', script: rest.join(' ') };

    default:
      return null;
  }
}

function parseBatchCommands(args: string[]): Record<string, unknown>[] {
  const commands: Record<string, unknown>[] = [];
  
  // Each argument after 'batch' is a command string
  for (const arg of args) {
    // Split the command string into parts
    const parts = arg.match(/(?:[^\s"]+|"[^"]*")+/g) || [];
    const cleanParts = parts.map(p => p.replace(/^"|"$/g, ''));
    
    const cmd = parseCommand(cleanParts);
    if (cmd) {
      commands.push(cmd);
    }
  }
  
  return commands;
}

// ============================================================================
// Output Formatting
// ============================================================================

function formatResponse(response: Response): string {
  if (!response.success) {
    return `\x1b[31m✗ Error:\x1b[0m ${response.error}`;
  }

  const data = response.data as Record<string, unknown>;

  if (data?.url && data?.title) {
    return `\x1b[32m✓\x1b[0m \x1b[1m${data.title}\x1b[0m\n\x1b[2m  ${data.url}\x1b[0m`;
  } else if (data?.snapshot) {
    return String(data.snapshot);
  } else if (data?.text !== undefined) {
    return String(data.text);
  } else if (data?.url) {
    return String(data.url);
  } else if (data?.title) {
    return String(data.title);
  } else if (data?.result !== undefined) {
    return typeof data.result === 'object' ? JSON.stringify(data.result, null, 2) : String(data.result);
  } else if (data?.closed) {
    return '\x1b[32m✓\x1b[0m Browser closed';
  } else {
    return '\x1b[32m✓\x1b[0m Done';
  }
}

function printResponse(response: Response, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(response));
  } else {
    console.log(formatResponse(response));
  }
}

// ============================================================================
// Main
// ============================================================================

const HELP = `
agent-browser - fast browser automation CLI

Usage: 
  agent-browser <command> [args] [--json]
  agent-browser batch <cmd1> <cmd2> ... [--json]

Commands:
  open <url>              Navigate to URL
  click <sel>             Click element (use @ref from snapshot)
  fill <sel> <text>       Fill input
  type <sel> <text>       Type text
  hover <sel>             Hover element
  snapshot [options]      Get accessibility tree with refs
  screenshot [path]       Take screenshot
  get text <sel>          Get text content
  get url                 Get current URL
  get title               Get page title
  press <key>             Press keyboard key
  wait <ms|sel>           Wait for time or element
  eval <js>               Evaluate JavaScript
  close                   Close browser

Snapshot Options:
  -i, --interactive       Only show interactive elements (buttons, links, inputs)
  -c, --compact           Remove empty structural elements
  -d, --depth <n>         Limit tree depth (e.g., --depth 3)
  -s, --selector <sel>    Scope snapshot to CSS selector

Batch Mode:
  batch <cmd1> <cmd2> ... Execute multiple commands in sequence
                          Each command is a quoted string

Options:
  --json                  Output JSON (for AI agents)

Examples:
  agent-browser open example.com
  agent-browser snapshot
  agent-browser click @e2
  agent-browser fill @e3 "hello"

  # Batch mode - execute multiple commands efficiently
  agent-browser batch "open example.com" "snapshot" "click a"
  agent-browser batch "open google.com" "snapshot" "get title" --json
`;

async function runBatch(commands: Record<string, unknown>[], json: boolean): Promise<void> {
  const results: Response[] = [];
  let hasError = false;

  for (const cmd of commands) {
    try {
      const response = await sendCommand(cmd);
      results.push(response);
      
      if (!json) {
        // Print each result as we go for non-JSON mode
        console.log(`\x1b[36m[${cmd.action}]\x1b[0m`);
        console.log(formatResponse(response));
        console.log();
      }
      
      if (!response.success) {
        hasError = true;
        break; // Stop on first error
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const errorResponse: Response = {
        id: String(cmd.id),
        success: false,
        error: message,
      };
      results.push(errorResponse);
      hasError = true;
      
      if (!json) {
        console.log(`\x1b[36m[${cmd.action}]\x1b[0m`);
        console.log(`\x1b[31m✗ Error:\x1b[0m ${message}`);
      }
      break;
    }
  }

  if (json) {
    console.log(JSON.stringify({
      success: !hasError,
      results,
      completed: results.length,
      total: commands.length,
    }));
  } else {
    console.log(`\x1b[2m─────────────────────────────────────\x1b[0m`);
    console.log(`Completed ${results.length}/${commands.length} commands`);
  }

  process.exit(hasError ? 1 : 0);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const cleanArgs = args.filter(a => !a.startsWith('--'));
  
  if (cleanArgs.length === 0 || args.includes('--help') || args.includes('-h')) {
    console.log(HELP);
    process.exit(0);
  }

  // Check for batch mode
  if (cleanArgs[0] === 'batch') {
    const batchArgs = cleanArgs.slice(1);
    if (batchArgs.length === 0) {
      console.error('\x1b[31mBatch mode requires at least one command\x1b[0m');
      console.log('\nExample: agent-browser batch "open example.com" "snapshot"');
      process.exit(1);
    }
    
    const commands = parseBatchCommands(batchArgs);
    if (commands.length === 0) {
      console.error('\x1b[31mNo valid commands found\x1b[0m');
      process.exit(1);
    }
    
    try {
      await ensureDaemon();
      await runBatch(commands, json);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (json) {
        console.log(JSON.stringify({ success: false, error: message }));
      } else {
        console.error('\x1b[31m✗ Error:\x1b[0m', message);
      }
      process.exit(1);
    }
    return;
  }

  // Single command mode
  const cmd = parseCommand(cleanArgs);
  
  if (!cmd) {
    console.error('\x1b[31mUnknown command:\x1b[0m', cleanArgs[0]);
    process.exit(1);
  }

  try {
    await ensureDaemon();
    const response = await sendCommand(cmd);
    printResponse(response, json);
    process.exit(response.success ? 0 : 1);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (json) {
      console.log(JSON.stringify({ success: false, error: message }));
    } else {
      console.error('\x1b[31m✗ Error:\x1b[0m', message);
    }
    process.exit(1);
  }
}

main();
