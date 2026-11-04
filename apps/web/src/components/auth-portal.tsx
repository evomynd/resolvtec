"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { FirebaseError } from "firebase/app";
import { GoogleAuthProvider, onAuthStateChanged, signInWithEmailAndPassword, signInWithPopup, signOut, type User } from "firebase/auth";
import { httpsCallable } from "firebase/functions";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { ArrowRight, BadgeCheck, Building2, Eye, EyeOff, LayoutDashboard, LockKeyhole, LogOut, Mail, ShieldCheck, Wrench } from "lucide-react";
import { Button } from "@/components/ui/button";
import { appRoles, loginSchema, roleLabels, type AppRole, type LoginInput } from "@/lib/auth/schema";
import { auth, functions } from "@/lib/firebase/client";

type AuthState = {
  user: User;
  role: AppRole | null;
  clienteId: string | null;
} | null;

const initialAdminEmail = "leandroalves.facilities@gmail.com";

async function getAuthState(user: User): Promise<NonNullable<AuthState>> {
  const token = await user.getIdTokenResult();
  const claimedRole = token.claims.role;
  const role = typeof claimedRole === "string" && appRoles.includes(claimedRole as AppRole)
    ? (claimedRole as AppRole)
    : null;
  const claimedClientId = token.claims.clienteId;
  return {
    user,
    role,
    clienteId: typeof claimedClientId === "string" ? claimedClientId : null,
  };
}

function friendlyAuthError(error: unknown) {
  if (!(error instanceof FirebaseError)) return "Não foi possível entrar. Tente novamente.";

  const messages: Record<string, string> = {
    "auth/invalid-credential": "E-mail ou senha inválidos.",
    "auth/user-disabled": "Este acesso está desativado. Fale com a equipe Resolv.tec.",
    "auth/too-many-requests": "Muitas tentativas. Aguarde alguns minutos e tente novamente.",
    "auth/network-request-failed": "Sem conexão com o serviço de autenticação.",
    "auth/popup-closed-by-user": "A janela do Google foi fechada antes de concluir o acesso.",
    "auth/popup-blocked": "O navegador bloqueou a janela do Google. Permita pop-ups e tente novamente.",
    "auth/unauthorized-domain": "Este domínio ainda não está autorizado no Firebase Authentication.",
  };
  return messages[error.code] ?? "Não foi possível entrar. Verifique seus dados e tente novamente.";
}

export function AuthPortal() {
  const [session, setSession] = useState<AuthState>(null);
  const [checkingSession, setCheckingSession] = useState(Boolean(auth));
  const [showPassword, setShowPassword] = useState(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [bootstrapRetrying, setBootstrapRetrying] = useState(false);
  const [googleSubmitting, setGoogleSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const firebaseConfigured = Boolean(auth);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  });

  useEffect(() => {
    if (!auth) return;

    return onAuthStateChanged(auth, async (user) => {
      if (!user) {
        setSession(null);
        setCheckingSession(false);
        return;
      }

      try {
        setSession(await getAuthState(user));
      } catch {
        setSession({ user, role: null, clienteId: null });
      } finally {
        setCheckingSession(false);
      }
    });
  }, []);

  const recordSuccessfulLogin = async () => {
    if (!functions) return;
    try {
      await httpsCallable(functions, "recordLogin")();
    } catch {
      // A temporary Functions outage should not invalidate an authenticated session.
    }
  };

  const bootstrapAdministrator = async (user: User) => {
    if (!functions) {
      setBootstrapError("O serviço de perfil está indisponível. Tente novamente em alguns instantes.");
      return;
    }

    setBootstrapRetrying(true);
    setBootstrapError(null);
    try {
      await httpsCallable(functions, "bootstrapInitialAdmin")();
      await user.getIdToken(true);
      const refreshedSession = await getAuthState(user);
      setSession(refreshedSession);
      if (refreshedSession.role !== "administrador") {
        setBootstrapError("A configuração não foi concluída. Atualize a sessão e tente novamente.");
      }
    } catch {
      setBootstrapError("Não foi possível concluir a configuração inicial. Tente novamente.");
    } finally {
      setBootstrapRetrying(false);
    }
  };

  const onSubmit = async (values: LoginInput) => {
    setAuthError(null);
    if (!auth) {
      setAuthError("Firebase ainda não foi configurado. Copie e preencha o .env.example para desenvolvimento local.");
      return;
    }

    try {
      await signInWithEmailAndPassword(auth, values.email, values.password);
      await recordSuccessfulLogin();
    } catch (error) {
      setAuthError(friendlyAuthError(error));
    }
  };

  const handleGoogleSignIn = async () => {
    setAuthError(null);
    setBootstrapError(null);
    if (!auth) {
      setAuthError("Firebase ainda não foi configurado. Preencha o arquivo de ambiente local.");
      return;
    }

    setGoogleSubmitting(true);
    try {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({ prompt: "select_account" });
      const credential = await signInWithPopup(auth, provider);
      await recordSuccessfulLogin();

      if (credential.user.email?.toLowerCase() === initialAdminEmail) {
        await bootstrapAdministrator(credential.user);
      }
    } catch (error) {
      setAuthError(friendlyAuthError(error));
    } finally {
      setGoogleSubmitting(false);
    }
  };

  const handleSignOut = async () => {
    if (!auth) return;
    setSigningOut(true);
    try {
      await signOut(auth);
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <main className="relative min-h-screen overflow-hidden px-5 py-5 sm:px-8 sm:py-7">
      <div aria-hidden="true" className="ambient ambient-one" />
      <div aria-hidden="true" className="ambient ambient-two" />

      <header className="relative z-10 mx-auto flex w-full max-w-7xl items-center justify-between">
        <Link className="brand-mark" href="/" aria-label="Resolv.tec — início">
          <span className="brand-word">resolv<span>.tec</span></span>
        </Link>
        <div className="flex items-center gap-2 rounded-full border border-border bg-surface/80 px-3 py-2 text-xs font-semibold text-muted">
          <span className="status-dot" />
          Manutenção inteligente
        </div>
      </header>

      <div className="relative z-10 mx-auto grid min-h-[calc(100vh-7rem)] w-full max-w-7xl items-center gap-12 py-12 lg:grid-cols-[1fr_0.85fr] lg:gap-20">
        <section className="mx-auto w-full max-w-xl lg:mx-0">
          <p className="eyebrow"><span /> GESTÃO PREDIAL, SEM PONTOS CEGOS</p>
          <h1 className="hero-title">
            Seu prédio em boas mãos.<br />
            <span>Seu dia, mais leve.</span>
          </h1>
          <p className="hero-copy">
            Preventiva, corretiva e inteligência conectadas em uma plataforma feita para manter tudo funcionando.
          </p>

          <div className="mt-10 grid gap-3 sm:grid-cols-3">
            <div className="value-card">
              <div className="value-icon"><Wrench size={17} aria-hidden="true" /></div>
              <p>Manutenção</p>
              <span>com rastreabilidade</span>
            </div>
            <div className="value-card">
              <div className="value-icon"><ShieldCheck size={17} aria-hidden="true" /></div>
              <p>Atendimento</p>
              <span>com SLA acompanhado</span>
            </div>
            <div className="value-card">
              <div className="value-icon"><Building2 size={17} aria-hidden="true" /></div>
              <p>Operação</p>
              <span>em um só lugar</span>
            </div>
          </div>
          <p className="regional-note">Barueri · Alphaville · Osasco · Santana de Parnaíba · Itapevi · Jandira</p>
        </section>

        <section className="auth-card" aria-labelledby="auth-title">
          <div className="auth-card-topline" />
          {checkingSession ? (
            <div className="flex min-h-80 items-center justify-center" role="status">Verificando acesso…</div>
          ) : session ? (
            <div className="p-7 sm:p-9">
              <div className="auth-icon"><BadgeCheck size={22} aria-hidden="true" /></div>
              <p className="eyebrow mt-6">ACESSO AUTENTICADO</p>
              <h2 id="auth-title" className="auth-title">Olá, {session.user.displayName || session.user.email?.split("@")[0] || "por aqui"}.</h2>
              <p className="mt-2 text-sm leading-6 text-muted">Sua sessão está segura. O que você pode acessar é definido pelo perfil autorizado da sua conta.</p>

              <div className="mt-6 rounded-2xl border border-border bg-[#101314]/70 p-4">
                <div className="flex items-center justify-between gap-3">
                  <span className="text-sm text-muted">Perfil</span>
                  <span className="role-chip">{session.role ? roleLabels[session.role] : "Pendente"}</span>
                </div>
                {session.role === "cliente" && session.clienteId && (
                  <div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
                    <span className="text-sm text-muted">Conta vinculada</span>
                    <span className="max-w-40 truncate text-sm font-semibold">{session.clienteId}</span>
                  </div>
                )}
              </div>
              {!session.role && (
                <p className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-sm text-amber-100">
                  Seu perfil ainda não foi definido. Peça ao administrador para concluir seu acesso.
                </p>
              )}
              {bootstrapError && <p className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-sm text-amber-100" role="status">{bootstrapError}</p>}
              {!session.role && session.user.email?.toLowerCase() === initialAdminEmail && (
                <Button className="mt-4 w-full" variant="secondary" onClick={() => void bootstrapAdministrator(session.user)} disabled={bootstrapRetrying}>
                  {bootstrapRetrying ? "Configurando administrador…" : "Tentar novamente"}
                </Button>
              )}
              {session.role === "cliente" && !session.clienteId && (
                <p className="mt-4 rounded-xl border border-amber-300/20 bg-amber-300/5 p-3 text-sm text-amber-100">
                  Falta vincular esta conta a um cliente. O acesso aos dados permanece bloqueado.
                </p>
              )}
              {session.role && (
                <Link className="panel-entry-button mt-7" href="/painel">
                  <LayoutDashboard size={16} aria-hidden="true" />
                  Abrir painel
                </Link>
              )}
              <Button className="mt-3 w-full" variant="secondary" onClick={handleSignOut} disabled={signingOut}>
                <LogOut size={16} aria-hidden="true" />
                {signingOut ? "Saindo…" : "Encerrar sessão"}
              </Button>
              <p className="mt-5 text-center text-xs text-muted">Nenhuma permissão é concedida somente pela interface.</p>
            </div>
          ) : (
            <div className="p-7 sm:p-9">
              <div className="auth-icon"><LockKeyhole size={21} aria-hidden="true" /></div>
              <p className="eyebrow mt-6">ÁREA SEGURA</p>
              <h2 id="auth-title" className="auth-title">Acesse sua operação</h2>
              <p className="mt-2 text-sm leading-6 text-muted">Acesse com sua conta Google ou use e-mail e senha cadastrados.</p>

              <div className="mt-7">
                <Button className="w-full" type="button" variant="secondary" onClick={handleGoogleSignIn} disabled={googleSubmitting || isSubmitting || !firebaseConfigured}>
                  {googleSubmitting ? "Conectando ao Google…" : "Continuar com Google"}
                  {!googleSubmitting && <ArrowRight size={17} aria-hidden="true" />}
                </Button>
                <div className="auth-divider"><span>ou entre com e-mail</span></div>
              </div>

              <form className="space-y-5" onSubmit={handleSubmit(onSubmit)} noValidate>
                <div>
                  <label className="field-label" htmlFor="email">E-mail corporativo</label>
                  <div className="field-wrap">
                    <Mail size={17} aria-hidden="true" />
                    <input
                      id="email"
                      type="email"
                      autoComplete="username"
                      placeholder="voce@empresa.com.br"
                      aria-invalid={Boolean(errors.email)}
                      aria-describedby={errors.email ? "email-error" : undefined}
                      {...register("email")}
                    />
                  </div>
                  {errors.email && <p className="field-error" id="email-error">{errors.email.message}</p>}
                </div>

                <div>
                  <label className="field-label" htmlFor="password">Senha</label>
                  <div className="field-wrap">
                    <LockKeyhole size={17} aria-hidden="true" />
                    <input
                      id="password"
                      type={showPassword ? "text" : "password"}
                      autoComplete="current-password"
                      placeholder="Sua senha"
                      aria-invalid={Boolean(errors.password)}
                      aria-describedby={errors.password ? "password-error" : undefined}
                      {...register("password")}
                    />
                    <button
                      type="button"
                      className="password-toggle"
                      onClick={() => setShowPassword((visible) => !visible)}
                      aria-label={showPassword ? "Ocultar senha" : "Mostrar senha"}
                    >
                      {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                    </button>
                  </div>
                  {errors.password && <p className="field-error" id="password-error">{errors.password.message}</p>}
                </div>

                {authError && <p className="auth-error" role="alert">{authError}</p>}
                {!firebaseConfigured && !authError && (
                  <p className="setup-note" role="status">Configure o Firebase localmente para habilitar o acesso.</p>
                )}

                <Button className="w-full" type="submit" disabled={isSubmitting || googleSubmitting || !firebaseConfigured}>
                  {isSubmitting ? "Entrando…" : "Entrar na plataforma"}
                  {!isSubmitting && <ArrowRight size={17} aria-hidden="true" />}
                </Button>
              </form>

              <div className="mt-6 flex items-start gap-2 border-t border-border pt-5 text-xs leading-5 text-muted">
                <ShieldCheck className="mt-0.5 shrink-0 text-accent" size={15} aria-hidden="true" />
                Acesso protegido por autenticação e permissões individuais.
              </div>
            </div>
          )}
        </section>
      </div>

      <footer className="relative z-10 mx-auto flex w-full max-w-7xl flex-col justify-between gap-2 border-t border-border/70 py-4 text-xs text-muted sm:flex-row">
        <span>Resolv.tec · Manutenção predial inteligente</span>
        <span>São Paulo · Brasil</span>
      </footer>
    </main>
  );
}
