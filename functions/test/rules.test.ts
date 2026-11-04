import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, it } from "vitest";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { getBytes, ref, uploadBytes } from "firebase/storage";

const projectId = "demo-resolvtec";
const firestoreRules = readFileSync(new URL("../../firestore.rules", import.meta.url), "utf8");
const storageRules = readFileSync(new URL("../../storage.rules", import.meta.url), "utf8");
let environment: RulesTestEnvironment;

beforeAll(async () => {
  environment = await initializeTestEnvironment({
    projectId,
    firestore: { host: "127.0.0.1", port: 8080, rules: firestoreRules },
    storage: { host: "127.0.0.1", port: 9199, rules: storageRules },
  });
});

afterAll(async () => {
  await environment.cleanup();
});

beforeEach(async () => {
  await environment.clearFirestore();
  await environment.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "clientes/cliente-a"), { clienteId: "cliente-a", razaoSocial: "Cliente A" });
    await setDoc(doc(db, "clientes/cliente-b"), { clienteId: "cliente-b", razaoSocial: "Cliente B" });
    await setDoc(doc(db, "os/os-a"), {
      clienteId: "cliente-a",
      tecnicoId: "tecnico-a",
      tecnicoUids: ["tecnico-a"],
      status: "aberta",
    });
    await setDoc(doc(db, "os/os-b"), {
      clienteId: "cliente-b",
      tecnicoId: "tecnico-b",
      tecnicoUids: ["tecnico-b"],
      status: "aberta",
    });
    await setDoc(doc(db, "execucoesPreventivas/run-a"), {
      planoId: "plano-a",
      clienteId: "cliente-a",
      tecnicoUids: ["tecnico-a"],
      topicos: { "topico-a": { status: "aguardando_foto_antes" } },
    });
    await setDoc(doc(db, "execucoesPreventivas/run-b"), {
      planoId: "plano-b",
      clienteId: "cliente-b",
      tecnicoUids: ["tecnico-b"],
      topicos: { "topico-b": { status: "em_andamento", iniciadoPor: "tecnico-b" } },
    });
  });
});

describe("Firestore tenant and role isolation", () => {
  it("allows a client to read only its own client and work orders", async () => {
    const db = environment.authenticatedContext("contato-a", {
      role: "cliente",
      clienteId: "cliente-a",
    }).firestore();

    await assertSucceeds(getDoc(doc(db, "clientes/cliente-a")));
    await assertSucceeds(getDoc(doc(db, "os/os-a")));
    await assertFails(getDoc(doc(db, "clientes/cliente-b")));
    await assertFails(getDoc(doc(db, "os/os-b")));
  });

  it("limits technicians to assigned work orders and denies tenant-wide reads", async () => {
    const db = environment.authenticatedContext("tecnico-a", { role: "tecnico" }).firestore();

    await assertSucceeds(getDoc(doc(db, "os/os-a")));
    await assertFails(getDoc(doc(db, "os/os-b")));
    await assertFails(getDoc(doc(db, "clientes/cliente-a")));
  });

  it("limits preventive execution metadata to assigned technicians", async () => {
    const db = environment.authenticatedContext("tecnico-a", { role: "tecnico" }).firestore();
    await assertSucceeds(getDoc(doc(db, "execucoesPreventivas/run-a")));
    await assertFails(getDoc(doc(db, "execucoesPreventivas/run-b")));
  });

  it("prevents analysts from deleting records directly", async () => {
    const db = environment.authenticatedContext("analista-a", { role: "analista" }).firestore();

    await assertFails(deleteDoc(doc(db, "clientes/cliente-a")));
    await assertFails(deleteDoc(doc(db, "os/os-a")));
    await assertSucceeds(getDoc(doc(db, "clientes/cliente-a")));
  });

  it("denies client writes and unauthenticated access", async () => {
    const clientDb = environment.authenticatedContext("contato-a", {
      role: "cliente",
      clienteId: "cliente-a",
    }).firestore();
    const anonymousDb = environment.unauthenticatedContext().firestore();

    await assertFails(setDoc(doc(clientDb, "os/new-os"), { clienteId: "cliente-a" }));
    await assertFails(getDoc(doc(anonymousDb, "clientes/cliente-a")));
  });
});

describe("Storage privacy and assignment checks", () => {
  it("allows an assigned technician to upload, but never exposes files directly", async () => {
    const storage = environment.authenticatedContext("tecnico-a", { role: "tecnico" }).storage();
    const file = ref(storage, "clientes/cliente-a/os/os-a/antes.jpg");

    await assertSucceeds(uploadBytes(file, new Uint8Array([1, 2, 3]), { contentType: "image/jpeg" }));
    await assertFails(getBytes(file));
  });

  it("rejects uploads to another tenant's work order", async () => {
    const storage = environment.authenticatedContext("tecnico-a", { role: "tecnico" }).storage();
    const file = ref(storage, "clientes/cliente-b/os/os-b/antes.jpg");

    await assertFails(uploadBytes(file, new Uint8Array([1, 2, 3]), { contentType: "image/jpeg" }));
  });

  it("allows assigned preventive photo stages and rejects wrong topic state or technician", async () => {
    const storage = environment.authenticatedContext("tecnico-a", { role: "tecnico" }).storage();
    const assignedAfterStorage = environment.authenticatedContext("tecnico-b", { role: "tecnico" }).storage();
    const before = ref(storage, "clientes/cliente-a/planosPreventivos/plano-a/execucoes/run-a/topicos/topico-a/antes/before.jpg");
    const afterBeforeStart = ref(storage, "clientes/cliente-a/planosPreventivos/plano-a/execucoes/run-a/topicos/topico-a/depois/too-early.jpg");
    const otherTenant = ref(storage, "clientes/cliente-b/planosPreventivos/plano-b/execucoes/run-b/topicos/topico-b/antes/foreign.jpg");
    const afterStarted = ref(assignedAfterStorage, "clientes/cliente-b/planosPreventivos/plano-b/execucoes/run-b/topicos/topico-b/depois/after.jpg");

    await assertSucceeds(uploadBytes(before, new Uint8Array([1, 2, 3]), { contentType: "image/jpeg" }));
    await assertFails(uploadBytes(afterBeforeStart, new Uint8Array([1, 2, 3]), { contentType: "image/jpeg" }));
    await assertFails(uploadBytes(otherTenant, new Uint8Array([1, 2, 3]), { contentType: "image/jpeg" }));
    await assertSucceeds(uploadBytes(afterStarted, new Uint8Array([1, 2, 3]), { contentType: "image/jpeg" }));
    await assertFails(getBytes(before));
  });
});
