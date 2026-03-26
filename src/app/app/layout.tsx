import { ReactNode } from "react";

export default function AppLayout({ children }: { children: ReactNode }) {
  return (
    <div style={{ minHeight: "100vh", background: "#0f0f0f", color: "white", fontFamily: "system-ui" }}>
      {children}
    </div>
  );
}