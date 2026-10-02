import sharp from 'sharp';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../public/pwa/admin-icon.svg', import.meta.url));
for (const [name, size] of [['admin-180.png', 180], ['admin-192.png', 192], ['admin-512.png', 512], ['admin-512-maskable.png', 512]]) {
  const destination = fileURLToPath(new URL('../public/pwa/' + name, import.meta.url));
  await sharp(source).resize(size, size).png().toFile(destination);
}
