"use client";

import dynamic from "next/dynamic";

const CatalogPanel = dynamic(
  () => import("@/components/catalog-panel").then((module) => module.CatalogPanel),
  {
    ssr: false,
    loading: () => (
      <main className="grid min-h-screen place-items-center text-sm text-muted" role="status">
        Carregando painel seguro…
      </main>
    ),
  },
);

export function CatalogClientBoundary() {
  return <CatalogPanel />;
}
