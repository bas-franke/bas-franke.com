/**
 * Browser and operating system from a user agent, coarse on purpose (no versions). Order matters: Edge, Opera and
 * Samsung Internet all claim to be Chrome, Chrome claims to be Safari, and iPads/iPhones mention "Mac OS X".
 */

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|OPT\/|OPiOS|Opera/, 'Opera'],
  [/SamsungBrowser/, 'Samsung Internet'],
  [/Firefox\/|FxiOS/, 'Firefox'],
  [/Chrome\/|CriOS|Chromium/, 'Chrome'],
  [/Safari\/|AppleWebKit.*Mobile\//, 'Safari'],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux|X11/, 'Linux'],
];

const match = (list: [RegExp, string][], ua: string) => list.find(([re]) => re.test(ua))?.[1] ?? 'Other';

export const parseUserAgent = (ua: string) => ({ browser: match(BROWSERS, ua), os: match(SYSTEMS, ua) });
