import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { setGlobalOptions } from "firebase-functions/v2";
import { z } from "zod";

if (getApps().length === 0) initializeApp();
setGlobalOptions({ region: "southamerica-east1", maxInstances: 10 });

const firestore = getFirestore();
const initialAdminEmail = "leandroalves.facilities@gmail.com";
const appRoleSchema = z.enum(["administrador", "analista", "tecnico", "cliente"]);
// Cloud Run must allow browser CORS preflights; each callable validates Firebase Auth below.
const callableOptions = { invoker: "public" as const };
const setUserRoleSchema = z.object({
  uid: z.string().trim().min(1),
  role: appRoleSchema,
  clienteId: z.string().trim().min(1).optional(),
});

export const setUserRole = onCall(callableOptions, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre na plataforma para continuar.");
  if (request.auth.token.role !== "administrador") {
    throw new HttpsError("permission-denied", "Somente administradores podem configurar perfis.");
  }

  const parsed = setUserRoleSchema.safeParse(request.data);
  if (!parsed.success) {
    throw new HttpsError("invalid-argument", "Dados do perfil inválidos.", parsed.error.flatten());
  }
  const { uid, role, clienteId } = parsed.data;
  if ((role === "cliente") !== Boolean(clienteId)) {
    throw new HttpsError("invalid-argument", "Informe clienteId somente para o perfil cliente.");
  }

  try {
    const user = await getAuth().getUser(uid);
    const before = {
      role: typeof user.customClaims?.role === "string" ? user.customClaims.role : null,
      clienteId: typeof user.customClaims?.clienteId === "string" ? user.customClaims.clienteId : null,
    };
    const claims: Record<string, unknown> = { ...(user.customClaims ?? {}), role };
    if (role === "cliente" && clienteId) claims.clienteId = clienteId;
    else delete claims.clienteId;

    await getAuth().setCustomUserClaims(uid, claims);
    const userRef = firestore.collection("usuarios").doc(uid);
    const auditRef = firestore.collection("auditoria").doc();
    const batch = firestore.batch();
    batch.set(userRef, {
      uid,
      email: user.email ?? null,
      role,
      ...(role === "cliente" && clienteId ? { clienteId } : {}),
      ativo: !user.disabled,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    batch.set(auditRef, {
      atorUid: request.auth.uid,
      acao: "usuario.perfil_alterado",
      alvo: { colecao: "usuarios", id: uid },
      antes: before,
      depois: { role, ...(clienteId ? { clienteId } : {}) },
      criadoEm: FieldValue.serverTimestamp(),
    });
    await batch.commit();
    return { ok: true };
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    throw new HttpsError("not-found", "Usuário não encontrado ou não foi possível atualizar o perfil.");
  }
});

export const recordLogin = onCall(callableOptions, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Autenticação necessária.");

  await firestore.collection("auditoria").add({
    atorUid: request.auth.uid,
    acao: "login.sucesso",
    alvo: { colecao: "usuarios", id: request.auth.uid },
    criadoEm: FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

export const bootstrapInitialAdmin = onCall(callableOptions, async (request) => {
  if (!request.auth) throw new HttpsError("unauthenticated", "Entre com sua conta Google para continuar.");
  const email = request.auth.token.email;
  if (
    typeof email !== "string"
    || email.toLowerCase() !== initialAdminEmail
    || request.auth.token.email_verified !== true
  ) {
    throw new HttpsError("permission-denied", "Somente a conta de administrador autorizada e verificada pode concluir esta configuração.");
  }

  const auth = getAuth();
  const user = await auth.getUser(request.auth.uid);
  if (!user.emailVerified || user.disabled || user.email?.toLowerCase() !== initialAdminEmail) {
    throw new HttpsError("permission-denied", "A conta não está habilitada para o bootstrap de administrador.");
  }

  const markerRef = firestore.collection("configuracoes").doc("initialAdmin");
  const marker = await markerRef.get();
  if (marker.exists && marker.data()?.uid !== user.uid) {
    throw new HttpsError("failed-precondition", "O administrador inicial já foi configurado.");
  }
  if (marker.exists && user.customClaims?.role === "administrador") {
    return { ok: true, alreadyConfigured: true };
  }

  const claims: Record<string, unknown> = { ...(user.customClaims ?? {}), role: "administrador" };
  delete claims.clienteId;
  await auth.setCustomUserClaims(user.uid, claims);

  const userRef = firestore.collection("usuarios").doc(user.uid);
  const auditRef = firestore.collection("auditoria").doc();
  await firestore.runTransaction(async (transaction) => {
    const currentMarker = await transaction.get(markerRef);
    if (currentMarker.exists && currentMarker.data()?.uid !== user.uid) {
      throw new HttpsError("failed-precondition", "O administrador inicial já foi configurado.");
    }
    if (!currentMarker.exists) {
      transaction.create(markerRef, {
        uid: user.uid,
        email: initialAdminEmail,
        criadoEm: FieldValue.serverTimestamp(),
      });
      transaction.set(auditRef, {
        atorUid: user.uid,
        acao: "usuario.bootstrap_administrador_inicial",
        alvo: { colecao: "usuarios", id: user.uid },
        antes: { role: null },
        depois: { role: "administrador" },
        criadoEm: FieldValue.serverTimestamp(),
      });
    }
    transaction.set(userRef, {
      uid: user.uid,
      email: user.email,
      nome: user.displayName ?? initialAdminEmail.split("@")[0],
      role: "administrador",
      ativo: true,
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
  });

  return { ok: true, alreadyConfigured: false };
});

export {
  assignExistingUser,
  assignTechniciansToUnit,
  completePreventiveTopic,
  getPreventivePhotoUrl,
  listCatalog,
  listTechnicianCoverage,
  listTechnicianOptions,
  preparePreventivePhoto,
  savePreventiveObservation,
  saveCatalogRecord,
  startPreventiveTopic,
  softDeleteCatalogRecord,
  updatePreventiveActivity,
  updateOwnProfile,
} from "./catalog.js";
