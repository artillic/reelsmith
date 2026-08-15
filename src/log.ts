const isTTY = process.stdout.isTTY === true;

function paint(code: string, s: string): string {
  return isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
}

export const log = {
  step(msg: string): void {
    console.log(paint('1;36', '▸ ') + msg);
  },
  info(msg: string): void {
    console.log('  ' + msg);
  },
  ok(msg: string): void {
    console.log(paint('32', '  ✓ ') + msg);
  },
  warn(msg: string): void {
    console.warn(paint('33', '  ! ') + msg);
  },
  error(msg: string): void {
    console.error(paint('31', '  ✗ ') + msg);
  },
};

export class UserError extends Error {}
