import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: '/app/advisor',
    name: 'VIVO OPS Asesor',
    short_name: 'VIVO Asesor',
    description: 'Operacion movil del asesor en VIVO OPS',
    start_url: '/app/advisor/orders',
    scope: '/app/advisor/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#090B10',
    theme_color: '#090B10',
    lang: 'es-VE',
    icons: [
      {
        src: '/pwa/advisor-192.png',
        sizes: '192x192',
        type: 'image/png',
      },
      {
        src: '/pwa/advisor-512.png',
        sizes: '512x512',
        type: 'image/png',
      },
      {
        src: '/pwa/advisor-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
