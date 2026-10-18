import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { api, loadToken, saveToken, setUnauthorizedHandler, type User } from "@/src/api";

type AuthState = {
  ready: boolean;
  user: User | null;
  signIn: (token: string, user: User) => Promise<void>;
  signOut: () => Promise<void>;
};

const Ctx = createContext<AuthState>({} as AuthState);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [user, setUser] = useState<User | null>(null);

  const signOut = useCallback(async () => {
    await saveToken(null);
    setUser(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => {
      saveToken(null);
      setUser(null);
    });
    (async () => {
      if (await loadToken()) {
        try {
          setUser(await api<User>("/auth/me"));
        } catch {
          await saveToken(null);
        }
      }
      setReady(true);
    })();
  }, []);

  const signIn = useCallback(async (token: string, u: User) => {
    await saveToken(token);
    setUser(u);
  }, []);

  return <Ctx.Provider value={{ ready, user, signIn, signOut }}>{children}</Ctx.Provider>;
}

export const useAuth = () => useContext(Ctx);
