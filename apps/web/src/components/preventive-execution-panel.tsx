"use client";
/* eslint-disable @next/next/no-img-element -- Signed Firebase URLs use a project-specific host and cannot be statically configured for next/image. */

import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { httpsCallable } from "firebase/functions";
import { ref, uploadBytes } from "firebase/storage";
import { Check, ChevronDown, ClipboardCheck, ImagePlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { functions, storage } from "@/lib/firebase/client";

type Activity = { id: string; descricao: string };
type Topic = { id: string; titulo: string; atividades: Activity[] };
type TopicExecution = {
  status: "aguardando_foto_antes" | "em_andamento" | "concluido";
  atividadesConcluidas: Record<string, boolean>;
  observacao: string;
  fotoAntesPath?: string;
  fotoDepoisPath?: string;
  iniciadoPor?: string;
};
type PreventivePlan = {
  id: string;
  clienteId: string;
  unidadeId: string;
  unidadeNome: string;
  ativoIdentificacao?: string;
  sistema: string;
  periodicidade: string;
  proximaExecucao: string;
  checklist: Topic[];
  execucaoId: string;
  execucaoTopicos: Record<string, TopicExecution>;
};
type PlanResponse = { items: PreventivePlan[] };
type PendingAction = { key: string; kind: "before" | "after" | "activity" | "observation" } | null;

function planError(error: unknown) {
  if (error instanceof Error) return error.message;
  return "Não foi possível atualizar o checklist preventivo.";
}

function topicStatusLabel(status: TopicExecution["status"] | undefined) {
  if (status === "concluido") return "Concluído";
  if (status === "em_andamento") return "Em andamento";
  return "Aguardando foto inicial";
}

function PreventivePhoto({ plan, topic, stage }: { plan: PreventivePlan; topic: Topic; stage: "antes" | "depois" }) {
  const photoQuery = useQuery({
    queryKey: ["preventive-photo", plan.execucaoId, topic.id, stage],
    queryFn: async () => {
      if (!functions) throw new Error("Firebase Functions não está configurado.");
      const call = httpsCallable<{ planoId: string; execucaoId: string; topicoId: string; etapa: "antes" | "depois" }, { url: string }>(functions, "getPreventivePhotoUrl");
      return (await call({ planoId: plan.id, execucaoId: plan.execucaoId, topicoId: topic.id, etapa: stage })).data.url;
    },
    staleTime: 4 * 60 * 1000,
  });

  if (photoQuery.isLoading) return <p className="text-xs text-muted">Carregando foto {stage}…</p>;
  if (photoQuery.error || !photoQuery.data) return <p className="text-xs text-muted">Foto {stage} registrada.</p>;
  return (
    <figure className="mt-3">
      {/* Signed Firebase URLs have a project-specific host and are intentionally not passed through Next Image optimization. */}
      <img className="max-h-64 w-full rounded-xl border border-border object-contain" src={photoQuery.data} alt={`Foto ${stage} · ${topic.titulo}`} />
      <figcaption className="mt-1 text-xs text-muted">Foto {stage}</figcaption>
    </figure>
  );
}

export function PreventiveExecutionPanel({ technicianUid }: { technicianUid: string }) {
  const queryClient = useQueryClient();
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [beforeFiles, setBeforeFiles] = useState<Record<string, File | undefined>>({});
  const [afterFiles, setAfterFiles] = useState<Record<string, File | undefined>>({});
  const [observations, setObservations] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<PendingAction>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const plansQuery = useQuery({
    queryKey: ["preventive-execution-plans", technicianUid],
    queryFn: async () => {
      if (!functions) throw new Error("Firebase Functions não está configurado.");
      const call = httpsCallable<{ entity: "planosPreventivos" }, PlanResponse>(functions, "listCatalog");
      return (await call({ entity: "planosPreventivos" })).data.items;
    },
    staleTime: 10_000,
  });

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ["preventive-execution-plans", technicianUid] });
  };

  const uploadPreventivePhoto = async (plan: PreventivePlan, topic: Topic, stage: "antes" | "depois", file: File) => {
    if (!functions || !storage) throw new Error("Firebase Storage não está configurado.");
    if (!new Set(["image/jpeg", "image/png", "image/webp"]).has(file.type)) throw new Error("Use uma foto JPG, PNG ou WEBP.");
    if (file.size >= 10 * 1024 * 1024) throw new Error("A foto deve ter menos de 10 MiB.");
    const prepare = httpsCallable<{
      planoId: string;
      topicoId: string;
      etapa: "antes" | "depois";
      mimeType: string;
    }, { executionId: string; objectPath: string }>(functions, "preparePreventivePhoto");
    const prepared = (await prepare({ planoId: plan.id, topicoId: topic.id, etapa: stage, mimeType: file.type })).data;
    await uploadBytes(ref(storage, prepared.objectPath), file, { contentType: file.type });
    return prepared.executionId;
  };

  const startTopic = async (plan: PreventivePlan, topic: Topic, file: File | undefined, key: string) => {
    if (!file) {
      setOperationError("Tire ou selecione a foto inicial antes de iniciar o tópico.");
      return;
    }
    setPending({ key, kind: "before" });
    setOperationError(null);
    setNotice(null);
    try {
      const executionId = await uploadPreventivePhoto(plan, topic, "antes", file);
      if (!functions) throw new Error("Firebase Functions não está configurado.");
      const start = httpsCallable<{ planoId: string; execucaoId: string; topicoId: string }, { ok: true }>(functions, "startPreventiveTopic");
      await start({ planoId: plan.id, execucaoId: executionId, topicoId: topic.id });
      setBeforeFiles((current) => ({ ...current, [key]: undefined }));
      setNotice(`Tópico “${topic.titulo}” iniciado com foto registrada.`);
      await refresh();
    } catch (error) {
      setOperationError(planError(error));
    } finally {
      setPending(null);
    }
  };

  const updateActivity = async (plan: PreventivePlan, topic: Topic, activity: Activity, checked: boolean, key: string) => {
    if (!functions) return;
    setPending({ key, kind: "activity" });
    setOperationError(null);
    try {
      const update = httpsCallable<{
        planoId: string;
        execucaoId: string;
        topicoId: string;
        atividadeId: string;
        concluida: boolean;
      }, { ok: true }>(functions, "updatePreventiveActivity");
      await update({ planoId: plan.id, execucaoId: plan.execucaoId, topicoId: topic.id, atividadeId: activity.id, concluida: checked });
      await refresh();
    } catch (error) {
      setOperationError(planError(error));
    } finally {
      setPending(null);
    }
  };

  const saveObservation = async (plan: PreventivePlan, topic: Topic, value: string, key: string) => {
    if (!functions) return;
    setPending({ key, kind: "observation" });
    setOperationError(null);
    try {
      const save = httpsCallable<{
        planoId: string;
        execucaoId: string;
        topicoId: string;
        observacao: string;
      }, { ok: true }>(functions, "savePreventiveObservation");
      await save({ planoId: plan.id, execucaoId: plan.execucaoId, topicoId: topic.id, observacao: value });
      setNotice("Observação salva.");
      await refresh();
    } catch (error) {
      setOperationError(planError(error));
    } finally {
      setPending(null);
    }
  };

  const completeTopic = async (plan: PreventivePlan, topic: Topic, file: File | undefined, key: string) => {
    if (!file) {
      setOperationError("Registre a foto final antes de concluir o tópico.");
      return;
    }
    setPending({ key, kind: "after" });
    setOperationError(null);
    setNotice(null);
    try {
      const currentObservation = plan.execucaoTopicos?.[topic.id]?.observacao ?? "";
      const observation = observations[key] ?? currentObservation;
      if (observation !== currentObservation) {
        if (!functions) throw new Error("Firebase Functions não está configurado.");
        const save = httpsCallable<{
          planoId: string;
          execucaoId: string;
          topicoId: string;
          observacao: string;
        }, { ok: true }>(functions, "savePreventiveObservation");
        await save({ planoId: plan.id, execucaoId: plan.execucaoId, topicoId: topic.id, observacao: observation });
      }
      const executionId = await uploadPreventivePhoto(plan, topic, "depois", file);
      if (!functions) throw new Error("Firebase Functions não está configurado.");
      const complete = httpsCallable<{ planoId: string; execucaoId: string; topicoId: string }, { ok: true }>(functions, "completePreventiveTopic");
      await complete({ planoId: plan.id, execucaoId: executionId, topicoId: topic.id });
      setAfterFiles((current) => ({ ...current, [key]: undefined }));
      setNotice(`Tópico “${topic.titulo}” concluído com foto final registrada.`);
      await refresh();
    } catch (error) {
      setOperationError(planError(error));
    } finally {
      setPending(null);
    }
  };

  if (plansQuery.isLoading) return <div className="rounded-2xl border border-border bg-surface p-8 text-center text-sm text-muted" role="status">Carregando planos preventivos…</div>;
  if (plansQuery.error) return <p className="rounded-xl border border-red-300/20 bg-red-300/5 p-3 text-sm text-red-100" role="alert">{planError(plansQuery.error)}</p>;
  const plans = plansQuery.data ?? [];

  return (
    <section className="space-y-5">
      <div>
        <p className="eyebrow"><span /> EXECUÇÃO TÉCNICA</p>
        <h1 className="mt-3 text-2xl font-bold tracking-tight">Planos preventivos</h1>
        <p className="mt-2 text-sm text-muted">Abra um tópico, registre a foto inicial, execute e marque as atividades. A conclusão exige foto final.</p>
      </div>
      {operationError && <p className="rounded-xl border border-red-300/20 bg-red-300/5 p-3 text-sm text-red-100" role="alert">{operationError}</p>}
      {notice && <p className="rounded-xl border border-accent/20 bg-accent/5 p-3 text-sm text-accent" role="status">{notice}</p>}
      {plans.length === 0 ? (
        <div className="rounded-2xl border border-border bg-surface p-8 text-center">
          <ClipboardCheck className="mx-auto text-muted" size={28} aria-hidden="true" />
          <p className="mt-3 font-semibold">Nenhum plano preventivo atribuído</p>
          <p className="mt-1 text-sm text-muted">Planos ligados às suas unidades aparecerão aqui.</p>
        </div>
      ) : plans.map((plan) => (
        <article key={plan.id} className="rounded-2xl border border-border bg-surface p-4 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-bold">{plan.ativoIdentificacao ? `${plan.ativoIdentificacao} · ${plan.unidadeNome}` : plan.unidadeNome || `Unidade ${plan.unidadeId}`}</h2>
              <p className="mt-1 text-sm text-muted">{plan.sistema} · {plan.periodicidade} · Próxima execução {plan.proximaExecucao}</p>
            </div>
            <span className="rounded-full border border-border px-3 py-1 text-xs text-muted">{plan.checklist.length} tópicos</span>
          </div>
          <div className="mt-4 space-y-3">
            {plan.checklist.map((topic, index) => {
              const key = `${plan.id}:${topic.id}`;
              const state = plan.execucaoTopicos?.[topic.id];
              const isOpen = expandedKey === key;
              const allDone = topic.atividades.every((activity) => state?.atividadesConcluidas?.[activity.id] === true);
              const topicPending = pending?.key === key;
              return (
                <section key={topic.id} className="overflow-hidden rounded-xl border border-border">
                  <button
                    type="button"
                    className="flex w-full items-center justify-between gap-3 p-3 text-left hover:bg-white/5 sm:p-4"
                    aria-expanded={isOpen}
                    onClick={() => { setExpandedKey(isOpen ? null : key); setOperationError(null); }}
                  >
                    <span className="min-w-0">
                      <span className="block font-semibold">{index + 1}. {topic.titulo}</span>
                      <span className="mt-1 block text-xs text-muted">{topic.atividades.length} atividades · {topicStatusLabel(state?.status)}</span>
                    </span>
                    <ChevronDown className={`shrink-0 transition-transform ${isOpen ? "rotate-180" : ""}`} size={18} aria-hidden="true" />
                  </button>
                  {isOpen && (
                    <div className="border-t border-border p-3 sm:p-4">
                      {state?.fotoAntesPath && <PreventivePhoto plan={plan} topic={topic} stage="antes" />}
                      {!state || state.status === "aguardando_foto_antes" ? (
                        <>
                          <fieldset className="mt-3 space-y-2">
                            <legend className="mb-2 text-sm font-bold">Atividades deste tópico</legend>
                            {topic.atividades.map((activity) => (
                              <label key={activity.id} className="flex cursor-not-allowed items-start gap-3 rounded-xl border border-border p-3 text-sm opacity-60">
                                <input className="mt-1 accent-[#A4F101]" type="checkbox" disabled />
                                <span>{activity.descricao}</span>
                              </label>
                            ))}
                          </fieldset>
                          <label className="field-label mt-4 block">Observação do tópico
                            <textarea className="catalog-input mt-2" rows={3} disabled value={state?.observacao ?? ""} placeholder="Disponível após enviar a foto inicial" />
                          </label>
                          <div className="mt-3 rounded-xl border border-border p-3">
                            <label className="field-label block">Foto inicial obrigatória
                            <input
                              className="catalog-input mt-2"
                              type="file"
                              accept="image/jpeg,image/png,image/webp"
                              capture="environment"
                              onChange={(event) => setBeforeFiles((current) => ({ ...current, [key]: event.target.files?.[0] }))}
                            />
                            </label>
                            {beforeFiles[key] && <p className="mt-2 text-xs text-muted">Selecionada: {beforeFiles[key]?.name}</p>}
                            <Button className="mt-3 w-full sm:w-auto" disabled={topicPending} onClick={() => void startTopic(plan, topic, beforeFiles[key], key)}>
                              <ImagePlus size={16} aria-hidden="true" /> {topicPending ? "Enviando foto…" : "Enviar foto e iniciar tópico"}
                            </Button>
                          </div>
                        </>
                      ) : state.status === "em_andamento" ? (
                        <>
                          <fieldset className="mt-4 space-y-2">
                            <legend className="mb-2 text-sm font-bold">Atividades</legend>
                            {topic.atividades.map((activity) => (
                              <label key={activity.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-border p-3 text-sm">
                                <input
                                  className="mt-1 accent-[#A4F101]"
                                  type="checkbox"
                                  checked={state.atividadesConcluidas?.[activity.id] === true}
                                  disabled={topicPending}
                                  onChange={(event) => void updateActivity(plan, topic, activity, event.target.checked, key)}
                                />
                                <span>{activity.descricao}</span>
                              </label>
                            ))}
                          </fieldset>
                          <label className="field-label mt-4 block">Observação do tópico
                            <textarea
                              className="catalog-input mt-2"
                              rows={3}
                              maxLength={2000}
                              value={observations[key] ?? state.observacao ?? ""}
                              onChange={(event) => setObservations((current) => ({ ...current, [key]: event.target.value }))}
                              placeholder="Registre condições encontradas, medições ou recomendações"
                            />
                          </label>
                          <Button type="button" variant="secondary" className="mt-2" disabled={topicPending} onClick={() => void saveObservation(plan, topic, observations[key] ?? state.observacao ?? "", key)}>
                            {pending?.kind === "observation" && topicPending ? "Salvando…" : "Salvar observação"}
                          </Button>
                          <div className="mt-4 rounded-xl border border-border p-3">
                            <label className="field-label block">Foto final obrigatória
                              <input
                                className="catalog-input mt-2"
                                type="file"
                                accept="image/jpeg,image/png,image/webp"
                                capture="environment"
                                disabled={!allDone || topicPending}
                                onChange={(event) => setAfterFiles((current) => ({ ...current, [key]: event.target.files?.[0] }))}
                              />
                            </label>
                            {!allDone && <p className="mt-2 text-xs text-muted">Marque todas as atividades para habilitar a foto final.</p>}
                            {afterFiles[key] && <p className="mt-2 text-xs text-muted">Selecionada: {afterFiles[key]?.name}</p>}
                            <Button className="mt-3 w-full sm:w-auto" disabled={!allDone || topicPending} onClick={() => void completeTopic(plan, topic, afterFiles[key], key)}>
                              <Check size={16} aria-hidden="true" /> {topicPending ? "Concluindo…" : "Enviar foto e concluir tópico"}
                            </Button>
                          </div>
                        </>
                      ) : (
                        <div className="mt-3">
                          <p className="flex items-center gap-2 text-sm font-semibold text-accent"><Check size={16} aria-hidden="true" /> Tópico concluído</p>
                          <ul className="mt-3 space-y-2 text-sm text-muted">
                            {topic.atividades.map((activity) => <li key={activity.id}>✓ {activity.descricao}</li>)}
                          </ul>
                          {state.observacao && <p className="mt-3 rounded-lg bg-background p-3 text-sm">{state.observacao}</p>}
                          {state.fotoDepoisPath && <PreventivePhoto plan={plan} topic={topic} stage="depois" />}
                        </div>
                      )}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        </article>
      ))}
    </section>
  );
}
