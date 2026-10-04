// Preserve the decimal precision returned by the provider. Store exact decimal
// totals as strings; convert to Number only at the API/UI boundary.
function parts(value) {
  const text = String(value);
  if (!/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text)) throw new Error('金额无效');
  const [mantissa, exponent = '0'] = text.toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const scale = fraction.length - Number(exponent);
  let units = BigInt(whole + fraction);
  if (scale < 0) units *= 10n ** BigInt(-scale);
  return { units, scale: Math.max(0, scale) };
}
export function decimalAdd(a, b, subtract = false) {
  const x = parts(a), y = parts(b), scale = Math.max(x.scale, y.scale);
  const units = x.units * 10n ** BigInt(scale - x.scale) + (subtract ? -1n : 1n) * y.units * 10n ** BigInt(scale - y.scale);
  const digits = String(units < 0n ? -units : units).padStart(scale + 1, '0');
  return (units < 0n ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}
export const decimalDifference = (a, b) => Number(decimalAdd(a, b, true));
export const decimalSum = values => Number(values.reduce((sum, value) => decimalAdd(sum, value), '0'));

export function decimalMultiply(a, b) {
  const x = parts(a), y = parts(b), scale = x.scale + y.scale, units = x.units * y.units;
  const digits = String(units < 0n ? -units : units).padStart(scale + 1, '0');
  return (units < 0n ? '-' : '') + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}
