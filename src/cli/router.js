/**
 * CLI command router using node:util parseArgs.
 * Zero dependencies — uses only Node.js built-ins.
 */
import { parseArgs } from 'node:util';
import { VERSION } from '../version.js';
import { ownDataProperty, toCoreDiagnostic } from '../core/errors.js';
import { normalizePresentationError } from '../core/error-policy.js';

/** @type {Map<string, { description: string, deprecated?: boolean, options?: object, handler: Function, subcommands?: Map<string, object> }>} */
const commands = new Map();

const DEPRECATED_STYLE_START = '\u001b[2;33m';
const ANSI_STYLE_RESET = '\u001b[0m';

export function register(name, config) {
  commands.set(name, config);
}

export function resultExitCode(result) {
  if ([130, 143].includes(result?.exit_code)) return result.exit_code;
  if (result?.success !== false) return 0;
  const diagnostics = [
    result,
    ...(Array.isArray(result?.errors) ? result.errors : []),
    ...(result?.error && typeof result.error === 'object' ? [result.error] : []),
  ];
  if (diagnostics.some((diagnostic) => diagnostic?.kind === 'cdp')) return 2;
  return result.failure_kind === 'cdp_connection' ? 2 : 1;
}

export function diagnosticExitCode(diagnostic) {
  if ([130, 143].includes(diagnostic?.exit_code)) return diagnostic.exit_code;
  return diagnostic?.kind === 'cdp' ? 2 : 1;
}

export function helpColorEnabled({ stream = process.stdout, env = process.env } = {}) {
  if (Object.prototype.hasOwnProperty.call(env || {}, 'NO_COLOR')) return false;
  return stream?.isTTY === true;
}

export function formatHelpDescription(config, {
  color = helpColorEnabled(),
} = {}) {
  const description = String(config?.description || '');
  if (config?.deprecated !== true) return description;
  const label = color
    ? `${DEPRECATED_STYLE_START}[deprecated]${ANSI_STYLE_RESET}`
    : '[deprecated]';
  return `${label} ${description}`;
}

function printHelp() {
  console.log('Usage: tv <command> [options]\n');
  console.log('Commands:');
  const maxLen = Math.max(...[...commands.keys()].map(k => k.length));
  for (const [name, cmd] of commands) {
    if (cmd.subcommands) {
      const subs = [...cmd.subcommands.keys()].join(', ');
      console.log(`  ${name.padEnd(maxLen + 2)}${formatHelpDescription(cmd)}  [${subs}]`);
    } else {
      console.log(`  ${name.padEnd(maxLen + 2)}${formatHelpDescription(cmd)}`);
    }
  }
  console.log('\nRun "tv <command> --help" for command-specific options.');
  console.log('\nDISCLAIMER');
  console.log('  Not affiliated with TradingView Inc. or Anthropic, PBC.');
  console.log('  Use subject to TradingView\'s Terms of Use: tradingview.com/policies');
}

function printCommandHelp(name, cmd) {
  if (cmd.subcommands) {
    console.log(`Usage: tv ${name} <subcommand> [options]\n`);
    console.log('Subcommands:');
    const maxLen = Math.max(...[...cmd.subcommands.keys()].map(sub => sub.length));
    for (const [sub, subConf] of cmd.subcommands) {
      console.log(`  ${sub.padEnd(maxLen + 2)}${formatHelpDescription(subConf)}`);
    }
  } else {
    console.log(`Usage: tv ${name} [options]\n`);
    console.log(formatHelpDescription(cmd));
  }
  const opts = cmd.options || {};
  if (Object.keys(opts).length > 0) {
    console.log('\nOptions:');
    for (const [k, v] of Object.entries(opts)) {
      const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
      console.log(`  ${flag.padEnd(26)}${v.description || ''}`);
    }
  }
}

export async function run(argv) {
  const args = argv.slice(2);

  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printHelp();
    process.exit(0);
  }

  if (args[0] === '--version' || args[0] === '-v') {
    console.log(VERSION);
    process.exit(0);
  }

  const cmdName = args[0];
  const cmd = commands.get(cmdName);

  if (!cmd) {
    console.error(`Unknown command: ${cmdName}`);
    console.error('Run "tv --help" for a list of commands.');
    process.exit(1);
  }

  // Handle subcommands (e.g., tv pine get)
  let handler, options;
  if (cmd.subcommands) {
    const subName = args[1];
    if (!subName || subName === '--help' || subName === '-h') {
      printCommandHelp(cmdName, cmd);
      process.exit(0);
    }
    const sub = cmd.subcommands.get(subName);
    if (!sub) {
      console.error(`Unknown subcommand: ${cmdName} ${subName}`);
      printCommandHelp(cmdName, cmd);
      process.exit(1);
    }
    handler = sub.handler;
    options = sub.options || {};
    // Parse remaining args after command + subcommand
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(2),
        options: { help: { type: 'boolean', short: 'h' }, ...options },
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        console.log(`Usage: tv ${cmdName} ${subName}${sub.usage ? ` ${sub.usage}` : ''} [options]\n`);
        console.log(formatHelpDescription(sub));
        if (Object.keys(options).length > 0) {
          console.log('\nOptions:');
          for (const [k, v] of Object.entries(options)) {
            const flag = v.short ? `-${v.short}, --${k}` : `    --${k}`;
            console.log(`  ${flag.padEnd(26)}${v.description || ''}`);
          }
        }
        process.exit(0);
      }
      await execute(handler, values, positionals);
    } catch (err) {
      handleError(err);
    }
  } else {
    handler = cmd.handler;
    options = cmd.options || {};
    try {
      const { values, positionals } = parseArgs({
        args: args.slice(1),
        options: { help: { type: 'boolean', short: 'h' }, ...options },
        allowPositionals: true,
        strict: false,
      });
      if (values.help) {
        printCommandHelp(cmdName, cmd);
        process.exit(0);
      }
      await execute(handler, values, positionals);
    } catch (err) {
      handleError(err);
    }
  }
}

async function execute(handler, values, positionals) {
  try {
    const result = await handler(values, positionals);
    const serialized = JSON.stringify(result, null, 2);
    const exitCode = resultExitCode(result);
    if (exitCode !== 0) {
      console.error(serialized);
      process.exit(exitCode);
    }
    console.log(serialized);
    process.exit(0);
  } catch (err) {
    handleError(err);
  }
}

function handleError(err) {
  const diagnostic = toCoreDiagnostic(normalizePresentationError(err, {
    phase: ownDataProperty(err, 'phase') || 'cli_execution',
  }));
  const { message, ...fields } = diagnostic;
  const payload = {
    success: false,
    ...fields,
    error: message,
  };
  console.error(JSON.stringify(payload, null, 2));
  process.exit(diagnosticExitCode(diagnostic));
}
