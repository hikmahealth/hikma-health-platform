import { QRCodeSVG } from "qrcode.react";
import { useEffect, useState } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const QR_SIZE = 200;

/**
 * The payload is the bare origin string and must stay that way. Mobile's
 * `qrParser` only recognises JSON as a `sync_hub` envelope and matches a cloud
 * server as a plain URL, so wrapping this in JSON makes `parseQRCode` return
 * null and the caller then `fetch`es the JSON text itself — which surfaces as
 * a misleading "URL is not reachable".
 */
function isUnreachableFromPhone(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return (
      hostname === "localhost" ||
      hostname === "127.0.0.1" ||
      hostname === "0.0.0.0" ||
      hostname === "[::1]" ||
      hostname.endsWith(".local")
    );
  } catch {
    return false;
  }
}

const STEPS = [
  "Open the Hikma Health app on the phone or tablet.",
  'On the login screen, tap "Register App with QR Code".',
  "Point the camera at the code on this page.",
  "Sign in with the user's email address and password.",
];

export function ConnectMobileAppCard() {
  // `window` does not exist during SSR, so the origin can only be read once the
  // component has hydrated. The QR box below is reserved at its final size so
  // the page does not shift when the value arrives.
  const [origin, setOrigin] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    setOrigin(window.location.origin);
  }, []);

  const handleCopy = async () => {
    if (!origin) return;
    await navigator.clipboard.writeText(origin);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const unreachable = origin !== null && isUnreachableFromPhone(origin);
  const insecure = origin !== null && origin.startsWith("http://");

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>Connect a mobile app</CardTitle>
        <CardDescription>
          Scanning this code tells the mobile app which server to sync with. It
          does not create an entry in the table below — use{" "}
          <span className="font-medium">Register New Device</span> for a sync
          hub or any client that needs its own API key.
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6 md:flex-row md:items-start">
        <div
          className="flex shrink-0 items-center justify-center rounded-lg border bg-white p-3"
          style={{ width: QR_SIZE + 24, height: QR_SIZE + 24 }}
        >
          {origin ? (
            <QRCodeSVG
              value={origin}
              bgColor="#fff"
              level="M"
              size={QR_SIZE}
              marginSize={0}
            />
          ) : (
            <div className="h-full w-full animate-pulse rounded bg-muted" />
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <ol className="list-decimal space-y-1.5 pl-5 text-sm">
            {STEPS.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>

          <div className="space-y-1.5">
            <div className="text-sm font-medium">Server address</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded-md border bg-muted px-3 py-2 font-mono text-sm">
                {origin ?? " "}
              </code>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={handleCopy}
                disabled={!origin}
                aria-label="Copy server address"
                className="shrink-0"
              >
                {copied ? (
                  <Check className="h-4 w-4" />
                ) : (
                  <Copy className="h-4 w-4" />
                )}
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              This is the address encoded in the code above. It has to be
              reachable from the phone, not just from this browser.
            </p>
          </div>

          {unreachable && (
            <div className="flex gap-2 rounded-md border border-yellow-400 bg-yellow-50 p-3 text-sm text-yellow-900">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                This address only resolves on the machine running this browser,
                so a phone will not be able to reach it. Open this page on the
                server's public address before scanning.
              </span>
            </div>
          )}

          {insecure && !unreachable && (
            <div className="flex gap-2 rounded-md border border-yellow-400 bg-yellow-50 p-3 text-sm text-yellow-900">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                This server is served over plain HTTP. Traffic between the app
                and the server will not be encrypted — use HTTPS in production.
              </span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
