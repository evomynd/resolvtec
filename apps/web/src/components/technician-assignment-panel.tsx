"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { httpsCallable } from "firebase/functions";
import { useMemo, useState } from "react";
import { Building2, Search, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { functions } from "@/lib/firebase/client";

type Client = { id: string; razaoSocial: string };
type Unit = { id: string; clienteId: string; nome: string; cidade: string; tecnicoUids: string[] };
type Technician = { uid: string; nome: string; email: string; whatsapp: string; cidadesAtendidas: string[]; especialidades: string[]; ativo: boolean };
type Coverage = { clientes: Client[]; unidades: Unit[]; tecnicos: Technician[] };

function normalizeCity(city: string) {
  return city.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase("pt-BR");
}

function loadErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : "Não foi possível carregar as atribuições.";
}

export function TechnicianAssignmentPanel() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [savedUnitId, setSavedUnitId] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);

  const coverageQuery = useQuery({
    queryKey: ["technician-assignment-coverage"],
    queryFn: async () => {
      if (!functions) throw new Error("Firebase Functions não está configurado.");
      const call = httpsCallable<void, Coverage>(functions, "listTechnicianCoverage");
      return (await call()).data;
    },
    staleTime: 15_000,
  });

  const assignmentMutation = useMutation({
    mutationFn: async (input: { unidadeId: string; tecnicoUids: string[] }) => {
      if (!functions) throw new Error("Firebase Functions não está configurado.");
      const call = httpsCallable<typeof input, { ok: true; tecnicoUids: string[] }>(functions, "assignTechniciansToUnit");
      return call(input);
    },
    onSuccess: async (_result, variables) => {
      await queryClient.invalidateQueries({ queryKey: ["technician-assignment-coverage"] });
      setDrafts((current) => {
        const next = { ...current };
        delete next[variables.unidadeId];
        return next;
      });
      setOperationError(null);
      setSavedUnitId(variables.unidadeId);
    },
    onError: (error) => {
      setOperationError(error instanceof Error ? error.message : "Não foi possível salvar a atribuição.");
      setSavedUnitId(null);
    },
  });

  const coverage = coverageQuery.data;
  const filteredClients = useMemo(() => {
    const query = search.trim().toLocaleLowerCase("pt-BR");
    return (coverage?.clientes ?? []).filter((client) => client.razaoSocial.toLocaleLowerCase("pt-BR").includes(query));
  }, [coverage?.clientes, search]);
  const selectedClient = coverage?.clientes.find((client) => client.id === selectedClientId) ?? null;
  const clientUnits = selectedClient
    ? (coverage?.unidades ?? []).filter((unit) => unit.clienteId === selectedClient.id)
    : [];
  const technicianLoad = useMemo(() => {
    const load = new Map<string, number>();
    for (const unit of coverage?.unidades ?? []) {
      for (const uid of new Set(unit.tecnicoUids)) load.set(uid, (load.get(uid) ?? 0) + 1);
    }
    return load;
  }, [coverage?.unidades]);

  if (coverageQuery.isLoading) {
    return <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted" role="status">Carregando clientes, unidades e técnicos…</div>;
  }
  if (coverageQuery.error) {
    return <p className="rounded-xl border border-red-300/20 bg-red-300/5 p-3 text-sm text-red-100" role="alert">{loadErrorMessage(coverageQuery.error)}</p>;
  }

  return (
    <section className="mt-6 grid gap-5 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="h-fit rounded-2xl border border-border bg-surface p-4">
        <p className="eyebrow"><span /> CLIENTES</p>
        <label className="field-label mt-4 block" htmlFor="client-search">Pesquisar cliente</label>
        <div className="catalog-search mt-2">
          <Search size={16} aria-hidden="true" />
          <input
            id="client-search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Comece a digitar o nome…"
            aria-label="Pesquisar clientes por nome"
          />
        </div>
        <div className="mt-3 max-h-[60vh] space-y-2 overflow-y-auto" role="listbox" aria-label="Clientes">
          {filteredClients.map((client) => (
            <button
              key={client.id}
              type="button"
              role="option"
              aria-selected={selectedClient?.id === client.id}
              className={`w-full rounded-xl border p-3 text-left text-sm font-semibold transition-colors ${selectedClient?.id === client.id ? "border-accent/40 bg-accent/10 text-accent" : "border-border text-foreground hover:bg-white/5"}`}
              onClick={() => { setSelectedClientId(client.id); setSavedUnitId(null); setOperationError(null); }}
            >
              <span className="block truncate">{client.razaoSocial}</span>
              <span className="mt-1 flex items-center gap-1 text-xs font-normal text-muted">
                <Building2 size={13} aria-hidden="true" />
                {(coverage?.unidades ?? []).filter((unit) => unit.clienteId === client.id).length} unidades
              </span>
            </button>
          ))}
          {filteredClients.length === 0 && <p className="rounded-xl border border-border p-3 text-sm text-muted">Nenhum cliente encontrado.</p>}
        </div>
      </aside>

      <div className="min-w-0">
        {!selectedClient ? (
          <div className="grid min-h-56 place-items-center rounded-2xl border border-border bg-surface p-8 text-center">
            <div><Users className="mx-auto text-muted" size={28} aria-hidden="true" /><p className="mt-3 font-semibold">Selecione um cliente</p><p className="mt-1 text-sm text-muted">As unidades aparecerão aqui para atribuição de técnicos.</p></div>
          </div>
        ) : (
          <>
            <div className="mb-4">
              <p className="eyebrow"><span /> UNIDADES DO CLIENTE</p>
              <h2 className="mt-3 text-xl font-bold">{selectedClient.razaoSocial}</h2>
              <p className="mt-1 text-sm text-muted">Escolha um ou mais técnicos por unidade. A lista começa por quem atende menos unidades.</p>
            </div>
            {operationError && <p className="mb-4 rounded-xl border border-red-300/20 bg-red-300/5 p-3 text-sm text-red-100" role="alert">{operationError}</p>}
            {clientUnits.length === 0 ? (
              <div className="rounded-2xl border border-border bg-surface p-7 text-center text-sm text-muted">Este cliente ainda não tem unidades ativas cadastradas.</div>
            ) : (
              <div className="space-y-4">
                {clientUnits.map((unit) => {
                  const selectedUids = drafts[unit.id] ?? unit.tecnicoUids;
                  const eligibleTechnicians = (coverage?.tecnicos ?? [])
                    .filter((technician) => technician.cidadesAtendidas.some((city) => normalizeCity(city) === normalizeCity(unit.cidade)))
                    .sort((left, right) => (technicianLoad.get(left.uid) ?? 0) - (technicianLoad.get(right.uid) ?? 0) || left.nome.localeCompare(right.nome, "pt-BR"));
                  const isChanged = drafts[unit.id] !== undefined && [...new Set(drafts[unit.id])].sort().join("|") !== [...new Set(unit.tecnicoUids)].sort().join("|");
                  return (
                    <article key={unit.id} className="rounded-2xl border border-border bg-surface p-4 sm:p-5">
                      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                        <div>
                          <h3 className="font-bold">{unit.nome}</h3>
                          <p className="mt-1 text-sm text-muted">{unit.cidade || "Cidade não cadastrada"}</p>
                        </div>
                        <span className="role-chip">{selectedUids.length} técnicos atribuídos</span>
                      </div>

                      {!unit.cidade ? (
                        <p className="mt-4 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-sm text-amber-100">Cadastre a cidade da unidade para filtrar técnicos elegíveis.</p>
                      ) : eligibleTechnicians.length === 0 ? (
                        <p className="mt-4 rounded-lg border border-amber-300/20 bg-amber-300/5 p-3 text-sm text-amber-100">Nenhum técnico ativo atende {unit.cidade}. Atualize cidades atendidas no cadastro do usuário técnico.</p>
                      ) : (
                        <fieldset className="mt-4">
                          <legend className="text-xs font-bold uppercase tracking-wide text-muted">Técnicos que atendem {unit.cidade}</legend>
                          <div className="mt-2 grid gap-2 sm:grid-cols-2">
                            {eligibleTechnicians.map((technician) => {
                              const checked = selectedUids.includes(technician.uid);
                              const count = technicianLoad.get(technician.uid) ?? 0;
                              return (
                                <label key={technician.uid} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${checked ? "border-accent/35 bg-accent/5" : "border-border hover:bg-white/5"}`}>
                                  <input
                                    className="mt-1 accent-[#A4F101]"
                                    type="checkbox"
                                    checked={checked}
                                    onChange={(event) => {
                                      setSavedUnitId(null);
                                      setDrafts((current) => {
                                        const existing = current[unit.id] ?? unit.tecnicoUids;
                                        const updated = event.target.checked
                                          ? [...new Set([...existing, technician.uid])]
                                          : existing.filter((uid) => uid !== technician.uid);
                                        return { ...current, [unit.id]: updated };
                                      });
                                    }}
                                  />
                                  <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-semibold">{technician.nome}</span>
                                    <span className="mt-1 block text-xs text-muted">{count} {count === 1 ? "unidade atendida" : "unidades atendidas"}</span>
                                  </span>
                                </label>
                              );
                            })}
                          </div>
                        </fieldset>
                      )}

                      {selectedUids.some((uid) => !eligibleTechnicians.some((technician) => technician.uid === uid)) && (
                        <p className="mt-3 text-xs text-amber-100">Há técnico atribuído que não atende mais a cidade da unidade. Remova a atribuição antes de salvar.</p>
                      )}
                      <div className="mt-4 flex items-center justify-between gap-3">
                        <p className="text-xs text-muted">Atribuição salva no cadastro da unidade.</p>
                        <Button
                          type="button"
                          disabled={!isChanged || assignmentMutation.isPending || selectedUids.some((uid) => !eligibleTechnicians.some((technician) => technician.uid === uid))}
                          onClick={() => assignmentMutation.mutate({ unidadeId: unit.id, tecnicoUids: selectedUids })}
                        >
                          {assignmentMutation.isPending ? "Salvando…" : savedUnitId === unit.id ? "Salvo" : "Salvar técnicos"}
                        </Button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
