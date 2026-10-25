// Texture worker: generates one Last Light texture set per message and sends the pixel buffers back (transferred).

import { type SetName, generate } from './texgen';

self.onmessage = (e: MessageEvent<{ name: SetName; n: number }>) => {
  const d = generate(e.data.name, e.data.n);
  (self as unknown as Worker).postMessage(d, [d.albedo.buffer, d.normal.buffer, d.orm.buffer]);
};
