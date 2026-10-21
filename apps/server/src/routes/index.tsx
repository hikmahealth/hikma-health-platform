import { createFileRoute, redirect } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import User from "@/models/user";
import { createServerFn } from "@tanstack/react-start";
import { getCookie, deleteCookie } from "@tanstack/react-start/server";
import Token from "@/models/token";

import { Option } from "effect";
import { Logger } from "@hikmahealth/js-utils";
import { isSetupComplete } from "@/lib/setup/is-setup-complete";

const checkToken = createServerFn({ method: "GET" }).handler(async () => {
  if (!(await isSetupComplete())) {
    return { isValid: false, setupRequired: true };
  }
  const token = Option.fromNullable(getCookie("token"));
  return Option.match(token, {
    onNone: () => {
      deleteCookie("token");
      return { isValid: false, setupRequired: false };
    },
    onSome: async (t) => {
      const user = await Token.getUser(t);
      const isValid = Option.isSome(user);
      if (!isValid) deleteCookie("token");
      return { isValid, setupRequired: false };
    },
  });
});

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const { isValid, setupRequired } = await checkToken();
    if (setupRequired) {
      throw redirect({ to: "/setup", replace: true });
    }
    if (isValid) {
      throw redirect({ to: "/app" });
    }
  },
  component: Login,
});

// export const xxx = createServerFn({ method: 'GET' }).handler(() => {
//   return "Hello"
// })

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [loadingAuth, setLoadingAuth] = useState(false);

  const navigate = Route.useNavigate();

  const handleLogin = async () => {
    Logger.log({ email, password });
    setLoadingAuth(true);
    const res = await fetch(`/api/auth/sign-in`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email: email.toLowerCase(),
        password,
      }),
    });
    const data: { user: User.T; token: string } | { error: string } =
      await res.json();
    Logger.log({ data });
    if ("error" in data) {
      setLoadingAuth(false);
      Logger.error(data);
      alert(data.error);
    } else {
      navigate({ to: "/app" });
    }
    setLoadingAuth(false);
  };

  return (
    <div className="container mx-auto flex flex-col items-center justify-center min-h-screen p-4">
      <div className="w-full max-w-md">
        <h1 className="text-center text-2xl font-bold mb-8">
          Hikma Health Administrators
        </h1>

        <div className="bg-white rounded-lg shadow-md p-6 border border-gray-200">
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                data-testid="email-input"
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@hikmahealth.org"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                data-testid="password-input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Your password"
                required
              />
            </div>

            <div className="flex items-center space-x-2">
              <div
                role="checkbox"
                aria-checked={remember}
                tabIndex={0}
                className={`h-4 w-4 border rounded cursor-pointer flex items-center justify-center ${remember ? "bg-primary border-primary" : "border-gray-300"}`}
                onClick={() => setRemember(!remember)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    setRemember(!remember);
                  }
                }}
              >
                {remember && <span className="text-white text-xs">✓</span>}
              </div>
              <Label
                htmlFor="remember"
                className="text-sm cursor-pointer"
                onClick={() => setRemember(!remember)}
              >
                Remember me
              </Label>
            </div>

            <Button
              id="login-button"
              disabled={loadingAuth}
              onClick={handleLogin}
              className="w-full"
            >
              {loadingAuth ? "Signing in..." : "Sign in"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
