import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { getApps } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { CallableRequest } from "firebase-functions/v2/https";
import {
  assignExistingUser,
  assignTechniciansToUnit,
  completePreventiveTopic,
  listCatalog,
  listTechnicianCoverage,
  listTechnicianOptions,
  preparePreventivePhoto,
  savePreventiveObservation,
  saveCatalogRecord,
  softDeleteCatalogRecord,
  startPreventiveTopic,
  updatePreventiveActivity,
} from "../src/catalog.js";

type TestAuth = { uid: string; token: Record<string, unknown> };

const firestore = getFirestore();
const auth = getAuth();
const collections = ["clientes", "unidades", "ativos", "tecnicos", "planosPreventivos", "execucoesPreventivas", "usuarios", "auditoria"];

function callableRequest(data: unknown, claims: TestAuth): CallableRequest<unknown> {
  return { data, auth: claims } as unknown as CallableRequest<unknown>;
}

async function clearTestCollections() {
  for (const collectionName of collections) {
    const snapshot = await firestore.collection(collectionName).get();
    const batches = [];
    for (let index = 0; index < snapshot.docs.length; index += 400) {
      const batch = firestore.batch();
      snapshot.docs.slice(index, index + 400).forEach((document) => batch.delete(document.ref));
      batches.push(batch.commit());
    }
    await Promise.all(batches);
  }
}

beforeAll(async () => {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) {
    throw new Error("catalog.test.ts só pode rodar com os emuladores Auth e Firestore ativos.");
  }
  if (getApps().length === 0) throw new Error("Firebase Admin não foi inicializado para os testes.");
});

afterAll(async () => {
  await clearTestCollections();
});

beforeEach(async () => {
  await clearTestCollections();
  await firestore.collection("clientes").doc("cliente-a").set({ clienteId: "cliente-a", razaoSocial: "Cliente A", ativo: true });
  await firestore.collection("clientes").doc("cliente-b").set({ clienteId: "cliente-b", razaoSocial: "Cliente B", ativo: true });
  await firestore.collection("unidades").doc("unidade-a").set({ clienteId: "cliente-a", nome: "Unidade A", endereco: { cidade: "Barueri" }, tecnicoUids: ["tecnico-a"] });
  await firestore.collection("unidades").doc("unidade-b").set({ clienteId: "cliente-b", nome: "Unidade B", endereco: { cidade: "Osasco" }, tecnicoUids: ["tecnico-b"] });
  await firestore.collection("ativos").doc("ativo-a").set({ clienteId: "cliente-a", unidadeId: "unidade-a", identificacao: "AC-A", tecnicoUids: ["tecnico-a"] });
  await firestore.collection("ativos").doc("ativo-b").set({ clienteId: "cliente-b", unidadeId: "unidade-b", identificacao: "AC-B", tecnicoUids: ["tecnico-b"] });
  await firestore.collection("planosPreventivos").doc("plano-a").set({
    clienteId: "cliente-a",
    unidadeId: "unidade-a",
    tecnicoId: "tecnico-a",
    periodicidade: "mensal",
    proximaExecucao: "2026-12-01",
    checklist: [{ id: "seguranca", titulo: "Segurança e Estrutura", atividades: [{ id: "disjuntores", descricao: "Inspecionar disjuntores" }] }],
  });
  await firestore.collection("planosPreventivos").doc("plano-b").set({ clienteId: "cliente-b", unidadeId: "unidade-b", tecnicoId: "tecnico-b" });
});

describe("Phase 2 catalog callable authorization", () => {
  it("returns only the authenticated client's tenant records", async () => {
    const request = callableRequest(
      { entity: "unidades" },
      { uid: "contato-a", token: { role: "cliente", clienteId: "cliente-a" } },
    );
    const result = await listCatalog.run(request);
    expect(result.items.map((item) => item.id)).toEqual(["unidade-a"]);

    const assetsRequest = callableRequest(
      { entity: "ativos" },
      { uid: "contato-a", token: { role: "cliente", clienteId: "cliente-a" } },
    );
    const assets = await listCatalog.run(assetsRequest);
    expect(assets.items.map((item) => item.id)).toEqual(["ativo-a"]);
  });

  it("limits technicians to units, assets, and plans assigned to their UID", async () => {
    const units = await listCatalog.run(callableRequest(
      { entity: "unidades" },
      { uid: "tecnico-a", token: { role: "tecnico" } },
    ));
    const assets = await listCatalog.run(callableRequest(
      { entity: "ativos" },
      { uid: "tecnico-a", token: { role: "tecnico" } },
    ));
    const plans = await listCatalog.run(callableRequest(
      { entity: "planosPreventivos" },
      { uid: "tecnico-a", token: { role: "tecnico" } },
    ));

    expect(units.items.map((item) => item.id)).toEqual(["unidade-a"]);
    expect(assets.items.map((item) => item.id)).toEqual(["ativo-a"]);
    expect(plans.items.map((item) => item.id)).toEqual(["plano-a"]);
    await expect(listCatalog.run(callableRequest(
      { entity: "clientes" },
      { uid: "tecnico-a", token: { role: "tecnico" } },
    ))).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("saves preventive plan topics and activities as structured checklist data", async () => {
    const result = await saveCatalogRecord.run(callableRequest({
      entity: "planosPreventivos",
      record: {
        clienteId: "cliente-a",
        unidadeId: "unidade-a",
        ativoId: "",
        sistema: "eletrica",
        periodicidade: "mensal",
        checklist: [
          { id: "seguranca", titulo: "Segurança e Estrutura", atividades: [{ id: "qgbt", descricao: "Inspecionar QGBT" }] },
          { id: "termografia", titulo: "Termografia e Inspeção Visual", atividades: [{ id: "medir", descricao: "Medir temperatura das conexões" }] },
        ],
        proximaExecucao: "2026-12-01",
        tecnicoId: "tecnico-a",
        equipeId: "",
      },
    }, { uid: "admin-a", token: { role: "administrador" } }));

    const saved = await firestore.collection("planosPreventivos").doc(result.id).get();
    expect(saved.data()?.checklist).toEqual([
      { id: "seguranca", titulo: "Segurança e Estrutura", atividades: [{ id: "qgbt", descricao: "Inspecionar QGBT" }] },
      { id: "termografia", titulo: "Termografia e Inspeção Visual", atividades: [{ id: "medir", descricao: "Medir temperatura das conexões" }] },
    ]);
  });

  it("requires before and after photos and audits preventive topic execution", async () => {
    const user = await auth.createUser({ email: `execucao-${Date.now()}@example.test` });
    const topicId = "seguranca";
    const activityId = "disjuntores";
    const storage = getStorage().bucket();
    const uploadedPaths: string[] = [];
    try {
      await auth.setCustomUserClaims(user.uid, { role: "tecnico" });
      await firestore.collection("unidades").doc("unidade-a").set({ tecnicoUids: [user.uid] }, { merge: true });
      await firestore.collection("planosPreventivos").doc("plano-a").set({ tecnicoId: user.uid }, { merge: true });

      const plans = await listCatalog.run(callableRequest(
        { entity: "planosPreventivos" },
        { uid: user.uid, token: { role: "tecnico" } },
      ));
      expect(plans.items.map((plan) => plan.id)).toContain("plano-a");

      const before = await preparePreventivePhoto.run(callableRequest({
        planoId: "plano-a",
        topicoId: topicId,
        etapa: "antes",
        mimeType: "image/jpeg",
      }, { uid: user.uid, token: { role: "tecnico" } }));
      uploadedPaths.push(before.objectPath);
      await expect(startPreventiveTopic.run(callableRequest({
        planoId: "plano-a",
        execucaoId: before.executionId,
        topicoId: topicId,
      }, { uid: user.uid, token: { role: "tecnico" } }))).rejects.toMatchObject({
        code: "failed-precondition",
        message: expect.stringContaining("ainda não foi enviada"),
      });

      await storage.file(before.objectPath).save(Buffer.from("before-photo"), { metadata: { contentType: "image/jpeg" } });
      await startPreventiveTopic.run(callableRequest({
        planoId: "plano-a",
        execucaoId: before.executionId,
        topicoId: topicId,
      }, { uid: user.uid, token: { role: "tecnico" } }));
      await updatePreventiveActivity.run(callableRequest({
        planoId: "plano-a",
        execucaoId: before.executionId,
        topicoId: topicId,
        atividadeId: activityId,
        concluida: true,
      }, { uid: user.uid, token: { role: "tecnico" } }));
      await savePreventiveObservation.run(callableRequest({
        planoId: "plano-a",
        execucaoId: before.executionId,
        topicoId: topicId,
        observacao: "Conexões sem aquecimento anormal.",
      }, { uid: user.uid, token: { role: "tecnico" } }));

      const after = await preparePreventivePhoto.run(callableRequest({
        planoId: "plano-a",
        topicoId: topicId,
        etapa: "depois",
        mimeType: "image/jpeg",
      }, { uid: user.uid, token: { role: "tecnico" } }));
      uploadedPaths.push(after.objectPath);
      await expect(completePreventiveTopic.run(callableRequest({
        planoId: "plano-a",
        execucaoId: after.executionId,
        topicoId: topicId,
      }, { uid: user.uid, token: { role: "tecnico" } }))).rejects.toMatchObject({
        code: "failed-precondition",
        message: expect.stringContaining("foto final ainda não foi enviada"),
      });

      await storage.file(after.objectPath).save(Buffer.from("after-photo"), { metadata: { contentType: "image/jpeg" } });
      await completePreventiveTopic.run(callableRequest({
        planoId: "plano-a",
        execucaoId: after.executionId,
        topicoId: topicId,
      }, { uid: user.uid, token: { role: "tecnico" } }));

      const execution = await firestore.collection("execucoesPreventivas").doc(before.executionId).get();
      expect(execution.data()?.topicos?.[topicId]).toMatchObject({
        status: "concluido",
        iniciadoPor: user.uid,
        atividadesConcluidas: { [activityId]: true },
        observacao: "Conexões sem aquecimento anormal.",
        fotoAntesPath: before.objectPath,
        fotoDepoisPath: after.objectPath,
      });
      const updatedPlan = await firestore.collection("planosPreventivos").doc("plano-a").get();
      expect(updatedPlan.data()?.proximaExecucao).toBe("2027-01-01");
      const scheduleAudit = await firestore.collection("auditoria")
        .where("acao", "==", "planosPreventivos.proxima_execucao_atualizada")
        .get();
      expect(scheduleAudit.size).toBe(1);
      const audits = await firestore.collection("auditoria").where("alvo.id", "==", before.executionId).get();
      expect(audits.docs.map((document) => document.data().acao)).toEqual(expect.arrayContaining([
        "preventivas.topico_iniciado",
        "preventivas.atividade_atualizada",
        "preventivas.observacao_atualizada",
        "preventivas.topico_concluido",
      ]));
    } finally {
      await Promise.all(uploadedPaths.map((path) => storage.file(path).delete({ ignoreNotFound: true }).catch(() => undefined)));
      await auth.deleteUser(user.uid);
    }
  });

  it("prevents analysts from assigning admin roles or soft-deleting records", async () => {
    await expect(assignExistingUser.run(callableRequest({
      email: "admin-candidato@example.com",
      nome: "Admin candidato",
      role: "administrador",
    }, { uid: "analista-a", token: { role: "analista" } }))).rejects.toMatchObject({ code: "permission-denied" });

    await expect(softDeleteCatalogRecord.run(callableRequest({
      entity: "clientes",
      id: "cliente-a",
    }, { uid: "analista-a", token: { role: "analista" } }))).rejects.toMatchObject({ code: "permission-denied" });
  });

  it("returns the invalid field name when an assignment fails validation", async () => {
    await expect(assignExistingUser.run(callableRequest({
      email: "tecnico@example.test",
      nome: "Técnico Demo",
      telefone: "11999999999",
      role: "tecnico",
    }, { uid: "admin-a", token: { role: "administrador" } }))).rejects.toMatchObject({
      code: "invalid-argument",
      message: expect.stringContaining("telefone"),
    });
  });

  it("lets an admin assign an existing Auth user and records claims/profile", async () => {
    const email = `cliente-${Date.now()}@example.test`;
    const user = await auth.createUser({ email, displayName: "Contato A" });
    try {
      const result = await assignExistingUser.run(callableRequest({
        email,
        nome: "Contato A",
        telefone: "+5511999999999",
        role: "cliente",
        clienteId: "cliente-a",
      }, { uid: "admin-a", token: { role: "administrador" } }));

      expect(result.uid).toBe(user.uid);
      const refreshedUser = await auth.getUser(user.uid);
      expect(refreshedUser.customClaims).toMatchObject({ role: "cliente", clienteId: "cliente-a" });
      const profile = await firestore.collection("usuarios").doc(user.uid).get();
      expect(profile.data()).toMatchObject({ email, role: "cliente", clienteId: "cliente-a", ativo: true });
    } finally {
      await auth.deleteUser(user.uid);
    }
  });

  it("creates a missing Auth user and returns a password setup link", async () => {
    const email = `analista-${Date.now()}@example.test`;
    const result = await assignExistingUser.run(callableRequest({
      email,
      nome: "Analista Demo",
      role: "analista",
    }, { uid: "admin-a", token: { role: "administrador" } }));

    try {
      expect(result.created).toBe(true);
      expect(result.passwordResetLink).toMatch(/^https?:\/\//);
      const user = await auth.getUser(result.uid);
      expect(user.email).toBe(email);
      expect(user.customClaims).toMatchObject({ role: "analista" });
      const profile = await firestore.collection("usuarios").doc(result.uid).get();
      expect(profile.data()).toMatchObject({ nome: "Analista Demo", role: "analista", ativo: true });
    } finally {
      await auth.deleteUser(result.uid);
    }
  });

  it("creates a technician profile with specialties and persists a new city option", async () => {
    const email = `tecnico-${Date.now()}@example.test`;
    const result = await assignExistingUser.run(callableRequest({
      email,
      nome: "Técnico de teste",
      telefone: "+5511999999999",
      role: "tecnico",
      cidadesAtendidas: ["Barueri"],
      especialidades: ["civil", "hidraulica"],
      outraCidade: "Jandira",
    }, { uid: "admin-a", token: { role: "administrador" } }));

    try {
      const technician = await firestore.collection("tecnicos").doc(result.uid).get();
      expect(technician.data()).toMatchObject({
        whatsapp: "+5511999999999",
        cidadesAtendidas: ["Barueri", "Jandira"],
        especialidades: ["civil", "hidraulica"],
      });
      const options = await listTechnicianOptions.run(callableRequest({}, { uid: "admin-a", token: { role: "administrador" } }));
      expect(options.cidades).toContain("Jandira");
    } finally {
      await auth.deleteUser(result.uid);
    }
  });

  it("restores a logically deleted technician and audits the restoration", async () => {
    const email = `tecnico-restaurado-${Date.now()}@example.test`;
    const created = await assignExistingUser.run(callableRequest({
      email,
      nome: "Técnico Restaurado",
      telefone: "+5511999999999",
      role: "tecnico",
      cidadesAtendidas: ["Barueri"],
      especialidades: ["civil"],
    }, { uid: "admin-a", token: { role: "administrador" } }));

    try {
      await softDeleteCatalogRecord.run(callableRequest({
        entity: "usuarios",
        id: created.uid,
      }, { uid: "admin-a", token: { role: "administrador" } }));

      const deletedUser = await auth.getUser(created.uid);
      expect(deletedUser.disabled).toBe(true);
      const deletedTechnician = await firestore.collection("tecnicos").doc(created.uid).get();
      expect(deletedTechnician.data()?.ativo).toBe(false);

      await expect(assignExistingUser.run(callableRequest({
        email,
        nome: "Técnico Restaurado",
        telefone: "+5511999999999",
        role: "tecnico",
        cidadesAtendidas: ["Barueri"],
        especialidades: ["civil"],
      }, { uid: "analista-a", token: { role: "analista" } }))).rejects.toMatchObject({ code: "permission-denied" });
      expect((await auth.getUser(created.uid)).disabled).toBe(true);

      const restored = await assignExistingUser.run(callableRequest({
        email,
        nome: "Técnico Restaurado",
        telefone: "+5511999999999",
        role: "tecnico",
        cidadesAtendidas: ["Barueri"],
        especialidades: ["civil"],
      }, { uid: "admin-a", token: { role: "administrador" } }));

  expect(restored).toMatchObject({ uid: created.uid, created: false, restored: true });
  expect(restored.passwordResetLink).toMatch(/^https?:\/\//);
      const activeUser = await auth.getUser(created.uid);
      expect(activeUser.disabled).toBe(false);
      expect(activeUser.customClaims).toMatchObject({ role: "tecnico" });
      const profile = await firestore.collection("usuarios").doc(created.uid).get();
      expect(profile.data()).toMatchObject({ role: "tecnico", ativo: true });
      expect(profile.data()?.deletedAt).toBeUndefined();
      expect(profile.data()?.deletedBy).toBeUndefined();
      const technician = await firestore.collection("tecnicos").doc(created.uid).get();
      expect(technician.data()).toMatchObject({ ativo: true, cidadesAtendidas: ["Barueri"], especialidades: ["civil"] });
      expect(technician.data()?.deletedAt).toBeUndefined();
      const audit = await firestore.collection("auditoria").where("acao", "==", "usuarios.restaurado").get();
      expect(audit.size).toBe(1);
      expect(audit.docs[0].data()).toMatchObject({
        atorUid: "admin-a",
        alvo: { colecao: "usuarios", id: created.uid },
        antes: { authDisabled: true, deletedBy: "admin-a" },
        depois: { role: "tecnico", ativo: true, authDisabled: false, restaurado: true },
      });
    } finally {
      await auth.deleteUser(created.uid);
    }
  });

  it("does not automatically reactivate an account disabled outside logical deletion", async () => {
    const user = await auth.createUser({ email: `desativado-${Date.now()}@example.test` });
    try {
      await auth.updateUser(user.uid, { disabled: true });
      await expect(assignExistingUser.run(callableRequest({
        email: user.email,
        nome: "Conta Desativada",
        role: "analista",
      }, { uid: "admin-a", token: { role: "administrador" } }))).rejects.toMatchObject({
        code: "failed-precondition",
        message: expect.stringContaining("não foi excluída pelo sistema"),
      });
      expect((await auth.getUser(user.uid)).disabled).toBe(true);
    } finally {
      await auth.deleteUser(user.uid);
    }
  });

  it("assigns several city-eligible technicians to one unit and exposes coverage", async () => {
    const users = await Promise.all([
      auth.createUser({ email: `barueri-a-${Date.now()}@example.test` }),
      auth.createUser({ email: `barueri-b-${Date.now()}@example.test` }),
    ]);
    try {
      for (const [index, user] of users.entries()) {
        await auth.setCustomUserClaims(user.uid, { role: "tecnico" });
        await firestore.collection("tecnicos").doc(user.uid).set({
          usuarioUid: user.uid,
          whatsapp: `+551199999999${index}`,
          cidadesAtendidas: ["barueri"],
          especialidades: ["civil"],
          ativo: true,
        });
      }

      const result = await assignTechniciansToUnit.run(callableRequest({
        unidadeId: "unidade-a",
        tecnicoUids: users.map((user) => user.uid),
      }, { uid: "admin-a", token: { role: "administrador" } }));
      expect(result.tecnicoUids).toEqual(users.map((user) => user.uid));

      const unit = await firestore.collection("unidades").doc("unidade-a").get();
      expect(unit.data()?.tecnicoUids).toEqual(users.map((user) => user.uid));
      const coverage = await listTechnicianCoverage.run(callableRequest({}, { uid: "admin-a", token: { role: "administrador" } }));
      expect(coverage.unidades.find((item) => item.id === "unidade-a")?.tecnicoUids).toEqual(users.map((user) => user.uid));
    } finally {
      await Promise.all(users.map((user) => auth.deleteUser(user.uid)));
    }
  });

  it("rejects a technician assignment when the unit city is not covered", async () => {
    const user = await auth.createUser({ email: `osasco-${Date.now()}@example.test` });
    try {
      await auth.setCustomUserClaims(user.uid, { role: "tecnico" });
      await firestore.collection("tecnicos").doc(user.uid).set({
        usuarioUid: user.uid,
        whatsapp: "+5511999999999",
        cidadesAtendidas: ["Osasco"],
        especialidades: ["civil"],
        ativo: true,
      });
      await expect(assignTechniciansToUnit.run(callableRequest({
        unidadeId: "unidade-a",
        tecnicoUids: [user.uid],
      }, { uid: "admin-a", token: { role: "administrador" } }))).rejects.toMatchObject({ code: "failed-precondition" });
    } finally {
      await auth.deleteUser(user.uid);
    }
  });

  it("soft deletes only as admin and writes an audit event", async () => {
    await softDeleteCatalogRecord.run(callableRequest({
      entity: "clientes",
      id: "cliente-a",
    }, { uid: "admin-a", token: { role: "administrador" } }));

    const client = await firestore.collection("clientes").doc("cliente-a").get();
    expect(client.data()).toMatchObject({ deletedBy: "admin-a", ativo: false });
    expect(client.data()?.deletedAt).toBeDefined();
    const audit = await firestore.collection("auditoria").where("acao", "==", "clientes.excluido_logicamente").get();
    expect(audit.size).toBe(1);
    expect(audit.docs[0].data()).toMatchObject({ atorUid: "admin-a", alvo: { id: "cliente-a" } });
  });
});
