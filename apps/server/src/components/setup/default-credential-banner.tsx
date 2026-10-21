import { Link } from "@tanstack/react-router";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { SEED_ADMIN_EMAIL } from "@/lib/setup/default-credential";

// Persistent warning while the seeded admin still has the published default password.
export function DefaultCredentialBanner({ userId }: { userId: string }) {
  return (
    <Alert
      variant="destructive"
      className="mb-4 border-destructive"
      data-testid="default-credential-banner"
    >
      <AlertTitle>This server still uses the default login</AlertTitle>
      <AlertDescription>
        <p>
          The account <strong>{SEED_ADMIN_EMAIL}</strong> still has its
          published default password, so anyone who knows it can sign in.{" "}
          <Link
            to="/app/users/edit/$"
            params={{ _splat: userId }}
            className="font-medium underline"
          >
            Change its password now
          </Link>
          .
        </p>
      </AlertDescription>
    </Alert>
  );
}
