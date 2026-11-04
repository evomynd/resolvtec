"use client";

import dynamic from "next/dynamic";

const AuthPortal = dynamic(
  () => import("@/components/auth-portal").then((module) => module.AuthPortal),
  {
    ssr: false,
    loading: () => (
      <main className="grid min-h-screen place-items-center px-6 text-sm text-muted" role="status">
        Carregando acesso seguro…
      </main>
    ),
  },
);

export function AuthClientBoundary() {
  return <AuthPortal />;
}
