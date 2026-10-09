"use client";

/**
 * Auth context: holds the current user, bootstraps from GET /api/auth/me
 * whenever a token exists, and exposes login/logout. Route protection lives
 * in the (shell) layout; real enforcement is always on the backend.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, ApiError, getToken, setToken } from "./api";
import type { Session, User } from "./types";

interface AuthCtx {
  user: User | null;
  loading: boolean;
  login: (session: Session) => void;
  logout: () => void;
}

const Ctx = createContext<AuthCtx>({
  user: null,
  loading: true,
  login: () => {},
  logout: () => {},
});

export function useAuth() {
  return useContext(Ctx);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    let alive = true;
    const token = getToken();
    if (!token) {
      setLoading(false);
      return;
    }
    api
      .get<User>("/api/auth/me")
      .then((u) => {
        if (alive) setUser(u);
      })
      .catch((e: unknown) => {
        if (e instanceof ApiError && e.status === 401) setToken(null);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  const login = useCallback((session: Session) => {
    setToken(session.token);
    setUser(session.user);
  }, []);

  const logout = useCallback(() => {
    setToken(null);
    setUser(null);
    router.replace("/login");
  }, [router]);

  // Guard: any (shell) page without a session bounces to /login.
  useEffect(() => {
    if (!loading && !user && pathname !== "/login") router.replace("/login");
  }, [loading, user, pathname, router]);

  return <Ctx.Provider value={{ user, loading, login, logout }}>{children}</Ctx.Provider>;
}
