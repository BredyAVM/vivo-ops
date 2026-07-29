import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';
import KitchenPwaRegistrar from './KitchenPwaRegistrar';
import './kitchen.css';

export const metadata: Metadata = {
  title: 'VIVO OPS Cocina',
  description: 'Operación móvil de cocina en VIVO OPS',
  manifest: '/pwa/kitchen.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'VIVO Cocina',
    statusBarStyle: 'black-translucent',
  },
  icons: {
    apple: '/pwa/kitchen-180.png',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#08090D',
};

export default function KitchenLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <KitchenPwaRegistrar />
      {children}
    </>
  );
}
