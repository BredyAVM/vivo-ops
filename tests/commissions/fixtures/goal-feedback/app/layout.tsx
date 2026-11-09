import type { ReactNode } from 'react';
import '../../../../../src/app/globals.css';

export default function Layout({ children }: { children: ReactNode }) {
  return <html lang="es"><body className="bg-[#0B0B0D] text-[#F7F7F8]">{children}</body></html>;
}
