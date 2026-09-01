import { createFileRoute } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FlaskConical, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Logger } from "@hikmahealth/js-utils";

export const Route = createFileRoute("/app/settings/hers")({
  component: RouteComponent,
});

type SubscribedClinic = {
  id: string;
  name: string | null;
  is_archived: boolean;
};

function RouteComponent() {
  const [clinics, setClinics] = useState<SubscribedClinic[]>([]);
  const [loading, setLoading] = useState(true);
  const [removingId, setRemovingId] = useState<string | null>(null);

  const fetchSubscriptions = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/hers/subscription");
      if (!res.ok) throw new Error("Failed to load subscriptions");
      const data: { clinics: SubscribedClinic[] } = await res.json();
      setClinics(data.clinics);
    } catch (err) {
      Logger.error({ msg: "Failed to fetch HERS subscriptions", err });
      toast.error("Failed to load HERS subscriptions");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSubscriptions();
  }, []);

  const handleUnsubscribe = async (clinicId: string) => {
    setRemovingId(clinicId);
    try {
      const res = await fetch("/api/hers/subscription", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinic_id: clinicId }),
      });

      if (!res.ok) throw new Error("Unsubscribe failed");

      toast.success("Clinic removed from HERS subscriptions");
      setClinics((prev) => prev.filter((c) => c.id !== clinicId));
    } catch (err) {
      Logger.error({ msg: "Failed to unsubscribe clinic from HERS", err });
      toast.error("Failed to unsubscribe clinic");
    } finally {
      setRemovingId(null);
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold flex items-center gap-2">
          <FlaskConical className="h-6 w-6" />
          HERS
        </h1>
        <p className="text-muted-foreground mt-1">
          Health Environmental Response System
        </p>
      </div>

      {/* Description — placeholder text, to be updated */}
      <Card>
        <CardHeader>
          <CardTitle>About HERS</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">
            HERS (Health Environmental Response System) enables clinics to
            receive real-time notifications about environmental changes — such
            as air quality shifts, weather events, and other environmental risk
            factors — relevant to each clinic's geographic location. Subscribing
            a clinic allows the platform to proactively surface environmental
            health risks for patients registered at that location.
          </p>
        </CardContent>
      </Card>

      {/* Subscribed Clinics */}
      <Card>
        <CardHeader>
          <CardTitle>Subscribed Clinics</CardTitle>
          <CardDescription>
            Clinics currently receiving HERS environmental notifications. To add
            a clinic, visit its individual clinic page.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading subscriptions...
            </div>
          ) : clinics.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No clinics are currently subscribed to HERS. Visit a clinic's page
              to subscribe.
            </p>
          ) : (
            <div className="space-y-2">
              {clinics.map((clinic) => (
                <div
                  key={clinic.id}
                  className="flex items-center justify-between p-3 rounded-md border"
                >
                  <div className="flex items-center gap-3">
                    <span className="font-medium text-sm">
                      {clinic.name ?? "Unnamed Clinic"}
                    </span>
                    <Badge
                      variant="outline"
                      className="text-green-600 border-green-600 text-xs"
                    >
                      ACTIVE
                    </Badge>
                    {clinic.is_archived && (
                      <Badge variant="secondary" className="text-xs">
                        Archived
                      </Badge>
                    )}
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={removingId === clinic.id}
                    onClick={() => handleUnsubscribe(clinic.id)}
                  >
                    {removingId === clinic.id && (
                      <Loader2 className="h-3 w-3 mr-2 animate-spin" />
                    )}
                    Deactivate
                  </Button>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
