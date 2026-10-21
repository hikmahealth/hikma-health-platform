import { createFileRoute, notFound } from "@tanstack/react-router";
import { SetupWizard } from "@/components/setup/setup-wizard";
import {
  checkSetupTokenFn,
  completeSetupFn,
  getSetupStatusFn,
} from "@/lib/server-functions/setup";

export const Route = createFileRoute("/setup")({
  beforeLoad: async () => {
    const { complete } = await getSetupStatusFn();
    if (complete) throw notFound();
  },
  component: SetupPage,
});

function SetupPage() {
  return (
    <SetupWizard
      checkToken={(token) => checkSetupTokenFn({ data: { token } })}
      completeSetup={(input) => completeSetupFn({ data: input })}
    />
  );
}
