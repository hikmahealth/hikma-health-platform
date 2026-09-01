import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  Calendar,
  Clock,
  Archive,
  Trash2,
  Edit,
  FlaskConical,
  Loader2,
} from "lucide-react";
import { format } from "date-fns";
import { Option } from "effect";
import { useEffect, useState } from "react";
import If from "@/components/if";
import {
  createDepartment,
  getClinicById,
  toggleDepartmentCapability,
} from "@/lib/server-functions/clinics";
import type Clinic from "@/models/clinic";
import type ClinicDepartment from "@/models/clinic-department";
import { Checkbox } from "@/components/ui/checkbox";
import { toast } from "sonner";
import { Logger } from "@hikmahealth/js-utils";

export const Route = createFileRoute("/app/clinics/$id/")({
  loader: async ({ params }) => {
    // Extract the clinic ID from the splat parameter
    const clinicId = params.id;
    if (!clinicId) {
      throw new Error("Clinic ID is required");
    }

    const result = await getClinicById({ data: { id: clinicId } });
    if (!result.ok) {
      throw new Error(result.error.message);
    }

    const { clinic, departments } = result.data;

    return { clinic, departments };
  },
  component: RouteComponent,
  errorComponent: ErrorComponent,
  pendingComponent: LoadingComponent,
});

function LoadingComponent() {
  return (
    <div className="container mx-auto p-6">
      <div className="animate-pulse">
        <div className="h-8 bg-gray-200 rounded w-1/4 mb-6"></div>
        <Card>
          <CardHeader>
            <div className="h-6 bg-gray-200 rounded w-1/3 mb-2"></div>
            <div className="h-4 bg-gray-200 rounded w-1/2"></div>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              <div className="h-4 bg-gray-200 rounded"></div>
              <div className="h-4 bg-gray-200 rounded"></div>
              <div className="h-4 bg-gray-200 rounded"></div>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

// Department Registration Form Component
interface ClinicRegistrationFormProps {
  formData: {
    name: string;
    code: string;
    description: string;
    can_perform_labs: boolean;
    can_dispense_medications: boolean;
  };
  setFormData: React.Dispatch<
    React.SetStateAction<{
      name: string;
      code: string;
      description: string;
      can_perform_labs: boolean;
      can_dispense_medications: boolean;
    }>
  >;
  onSubmit: (e: React.FormEvent) => void;
  onCancel: () => void;
  isSubmitting: boolean;
}

function ClinicRegistrationForm({
  formData,
  setFormData,
  onSubmit,
  onCancel,
  isSubmitting,
}: ClinicRegistrationFormProps) {
  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <div>
        <Label htmlFor="department-name">
          Name <span className="text-red-500">*</span>
        </Label>
        <Input
          id="department-name"
          type="text"
          placeholder="e.g., Emergency Department"
          value={formData.name}
          onChange={(e) =>
            setFormData({
              ...formData,
              name: e.target.value,
            })
          }
          required
          disabled={isSubmitting}
        />
      </div>

      <div>
        <Label htmlFor="department-code">Code (optional)</Label>
        <Input
          id="department-code"
          type="text"
          placeholder="e.g., ED"
          value={formData.code}
          onChange={(e) =>
            setFormData({
              ...formData,
              code: e.target.value,
            })
          }
          disabled={isSubmitting}
        />
      </div>

      <div>
        <Label htmlFor="department-description">Description (optional)</Label>
        <Textarea
          id="department-description"
          placeholder="Brief description of the department"
          value={formData.description}
          onChange={(e) =>
            setFormData({
              ...formData,
              description: e.target.value,
            })
          }
          disabled={isSubmitting}
          rows={3}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Checkbox
          label="Can Dispense Medications"
          checked={formData.can_dispense_medications}
          onCheckedChange={(checked) =>
            setFormData({
              ...formData,
              can_dispense_medications: checked as boolean,
            })
          }
          disabled={isSubmitting}
        />

        <Checkbox
          label="Can Perform Lab Tests"
          checked={formData.can_perform_labs}
          onCheckedChange={(checked) =>
            setFormData({
              ...formData,
              can_perform_labs: checked as boolean,
            })
          }
          disabled={isSubmitting}
        />
      </div>

      <div className="flex gap-2">
        <Button type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Creating..." : "Create Department"}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={isSubmitting}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}

function ErrorComponent({ error }: { error: Error }) {
  return (
    <div className="container mx-auto p-6">
      <Card className="border-red-200 bg-red-50">
        <CardHeader>
          <CardTitle className="text-red-900">Error Loading Clinic</CardTitle>
          <CardDescription className="text-red-700">
            {error.message ||
              "An error occurred while loading the clinic details"}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link to="/app/clinics">
            <Button variant="outline" className="gap-2">
              <ArrowLeft className="h-4 w-4" />
              Back to Clinics
            </Button>
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}

function RouteComponent() {
  const { clinic, departments } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const route = useRouter();

  const [departmentSectionState, setDepartmentSectionState] = useState<
    "view" | "edit"
  >("view");
  const [departmentFormData, setDepartmentFormData] = useState({
    name: "",
    code: "",
    description: "",
    can_perform_labs: false,
    can_dispense_medications: false,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // HERS subscription state
  const [hersSubscribed, setHersSubscribed] = useState<boolean | null>(null);
  const [hersLoading, setHersLoading] = useState(false);

  useEffect(() => {
    fetch("/api/hers/subscription")
      .then((res) => res.json())
      .then((data: { clinics: Array<{ id: string }> }) => {
        setHersSubscribed(data.clinics.includes(clinic.id));
      })
      .catch(() => {
        setHersSubscribed(null);
      });
  }, [clinic.id]);

  const handleHersSubscribe = async () => {
    setHersLoading(true);
    try {
      const res = await fetch("/api/hers/subscription", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinic_id: clinic.id }),
      });

      if (!res.ok) {
        throw new Error("Subscription failed");
      }

      toast.success("Clinic subscribed to HERS notifications");
      setHersSubscribed(true);
    } catch (error) {
      Logger.error({ msg: "Failed to subscribe to HERS", error });
      toast.error("Failed to subscribe clinic to HERS");
    } finally {
      setHersLoading(false);
    }
  };

  const handleHersUnsubscribe = async () => {
    setHersLoading(true);
    try {
      const res = await fetch("/api/hers/subscription", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinic_id: clinic.id }),
      });

      if (!res.ok) {
        throw new Error("Unsubscription failed");
      }

      toast.success("Clinic removed from HERS notifications");
      setHersSubscribed(false);
    } catch (error) {
      Logger.error({ msg: "Failed to unsubscribe from HERS", error });
      toast.error("Failed to unsubscribe clinic from HERS");
    } finally {
      setHersLoading(false);
    }
  };

  const formatDate = (date: Date | string | null | undefined) => {
    if (!date) return "N/A";
    try {
      const dateObj = typeof date === "string" ? new Date(date) : date;
      return format(dateObj, "PPP p");
    } catch {
      return "Invalid date";
    }
  };

  const handleEditClinic = () => {
    navigate({ to: `/app/clinics/edit/${clinic.id}` });
  };

  const handleToggleCapability = async (
    clinicId: string,
    departmentId: string,
    capability: ClinicDepartment.DepartmentCapability,
  ) => {
    let toastId = toast.loading("Toggling capability...");
    try {
      await toggleDepartmentCapability({
        data: { clinicId, departmentId, capability },
      });

      route.invalidate({ sync: true });
    } catch (error) {
      Logger.error(error);
      alert("Failed to toggle capability");
    } finally {
      toast.dismiss(toastId);
    }
  };

  const handleCreateDepartment = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!departmentFormData.name.trim()) {
      alert("Department name is required");
      return;
    }

    setIsSubmitting(true);
    try {
      const result = await createDepartment({
        data: {
          clinicId: clinic.id,
          name: departmentFormData.name,
          code: departmentFormData.code || "",
          description: departmentFormData.description || "",
          can_perform_labs: departmentFormData.can_perform_labs,
          can_dispense_medications: departmentFormData.can_dispense_medications,
        },
      });

      if (result.success) {
        // Reset form and refresh the page to show new department
        setDepartmentFormData({
          name: "",
          code: "",
          description: "",
          can_perform_labs: false,
          can_dispense_medications: false,
        });
        setDepartmentSectionState("view");
        navigate({ to: ".", replace: true });
      }
    } catch (error) {
      Logger.error({ msg: "Failed to create department:", error });
      alert("Failed to create department. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      {/* Header with navigation */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-4">
          <h1 className="text-3xl font-bold">Clinic Details</h1>
        </div>
        <div className="flex gap-2">
          <Button
            onClick={handleEditClinic}
            variant="outline"
            className="gap-2"
          >
            <Edit className="h-4 w-4" />
            Edit
          </Button>
        </div>
      </div>

      {/* Main clinic information card */}
      <Card className="mb-6">
        <CardHeader>
          <div className="flex items-start justify-between">
            <div>
              <CardTitle className="text-2xl">
                {clinic.name || "Unnamed Clinic"}
              </CardTitle>
              <CardDescription className="mt-1">
                ID:{" "}
                <code className="text-xs bg-gray-100 px-2 py-1 rounded">
                  {clinic.id}
                </code>
              </CardDescription>
            </div>
            <div className="flex gap-2">
              {clinic.is_archived && (
                <Badge variant="secondary" className="gap-1">
                  <Archive className="h-3 w-3" />
                  Archived
                </Badge>
              )}
              {clinic.is_deleted && (
                <Badge variant="destructive" className="gap-1">
                  <Trash2 className="h-3 w-3" />
                  Deleted
                </Badge>
              )}
              {!clinic.is_archived && !clinic.is_deleted && (
                <Badge variant="default" className="bg-green-600">
                  Active
                </Badge>
              )}
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            {/* Timestamps section */}
            <div className="border-t pt-4">
              <h3 className="font-semibold mb-3">Timestamps</h3>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="flex items-center gap-2 text-sm">
                  <Calendar className="h-4 w-4 text-gray-500" />
                  <span className="text-gray-600">Created:</span>
                  <span className="font-medium">
                    {formatDate(clinic.created_at)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Clock className="h-4 w-4 text-gray-500" />
                  <span className="text-gray-600">Updated:</span>
                  <span className="font-medium">
                    {formatDate(clinic.updated_at)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Clock className="h-4 w-4 text-gray-500" />
                  <span className="text-gray-600">Last Modified:</span>
                  <span className="font-medium">
                    {formatDate(clinic.last_modified)}
                  </span>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <Calendar className="h-4 w-4 text-gray-500" />
                  <span className="text-gray-600">Server Created:</span>
                  <span className="font-medium">
                    {formatDate(clinic.server_created_at)}
                  </span>
                </div>
                {clinic.deleted_at && (
                  <div className="flex items-center gap-2 text-sm sm:col-span-2">
                    <Trash2 className="h-4 w-4 text-red-500" />
                    <span className="text-gray-600">Deleted:</span>
                    <span className="font-medium text-red-600">
                      {formatDate(clinic.deleted_at)}
                    </span>
                  </div>
                )}
              </div>
            </div>

            {/* Additional information */}
            <div className="border-t pt-4">
              <h3 className="font-semibold mb-3">Additional Information</h3>
              <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Status:</span>
                  <span className="font-medium">
                    {clinic.is_deleted
                      ? "Deleted"
                      : clinic.is_archived
                        ? "Archived"
                        : "Active"}
                  </span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-gray-600">Clinic Name:</span>
                  <span className="font-medium">
                    {clinic.name || "Not specified"}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Clinic Departments Information Card */}
      <Card className="mb-6">
        <CardHeader>
          <CardTitle>Clinic Departments</CardTitle>
          <CardDescription>Manage clinic departments</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-4">
            <div className="grid grid-cols-1 gap-4">
              {departments.map((department) => (
                <div
                  key={department.id}
                  className="border rounded-lg p-4 hover:bg-gray-50 transition-colors"
                >
                  <div className="flex items-start justify-between">
                    <div className="space-y-1">
                      <h4 className="font-medium text-sm">{department.name}</h4>
                      {department.code && (
                        <p className="text-xs text-gray-500">
                          Code: {department.code}
                        </p>
                      )}
                      {department.description && (
                        <p className="text-sm text-gray-600 mt-2">
                          {department.description}
                        </p>
                      )}

                      {/*Manage what the clinic can do directly here*/}

                      <div className="space-y-2">
                        <p className="text-sm text-gray-600 mt-2">
                          Capabilities:
                        </p>
                        <Checkbox
                          label="Can Dispense Medications"
                          size="sm"
                          checked={department.can_dispense_medications}
                          onCheckedChange={() =>
                            handleToggleCapability(
                              department.clinic_id,
                              department.id,
                              "can_dispense_medications",
                            )
                          }
                        />

                        <Checkbox
                          label="Can Perform Labs"
                          size="sm"
                          checked={department.can_perform_labs}
                          onCheckedChange={() =>
                            handleToggleCapability(
                              department.clinic_id,
                              department.id,
                              "can_perform_labs",
                            )
                          }
                        />
                      </div>
                    </div>
                    <div className="flex gap-2">
                      {department.can_dispense_medications && (
                        <Badge variant="secondary" className="text-xs">
                          Can Dispense Medications
                        </Badge>
                      )}
                      {department.can_perform_labs && (
                        <Badge variant="secondary" className="text-xs">
                          Can do Lab Tests
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              ))}
              {departments.length === 0 && (
                <div className="text-gray-500">No departments found</div>
              )}
            </div>

            {/* New Department Form section */}
            <If show={departmentSectionState === "edit"}>
              <div className="border-t pt-4">
                <h3 className="font-semibold mb-3">New Department Form</h3>
                {/* CREATE THE MINIMAL FORM HERE */}
                <ClinicRegistrationForm
                  formData={departmentFormData}
                  setFormData={setDepartmentFormData}
                  onSubmit={handleCreateDepartment}
                  onCancel={() => {
                    setDepartmentSectionState("view");
                    setDepartmentFormData({
                      name: "",
                      code: "",
                      description: "",
                      can_perform_labs: false,
                      can_dispense_medications: false,
                    });
                  }}
                  isSubmitting={isSubmitting}
                />
              </div>
            </If>
            <div className="flex flex-wrap gap-2">
              <If show={departmentSectionState === "view"}>
                <Button
                  onClick={() =>
                    departmentSectionState === "view"
                      ? setDepartmentSectionState("edit")
                      : setDepartmentSectionState("view")
                  }
                  variant="outline"
                >
                  Add Department
                </Button>
              </If>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Action buttons */}
      <Card>
        <CardHeader>
          <CardTitle>Actions</CardTitle>
          <CardDescription>Manage this clinic</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            <Button asChild variant="outline">
              <Link to="/app/patients" search={{ clinicId: clinic.id }}>
                View Patients
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link to="/app/users" search={{ clinicId: clinic.id }}>
                View Staff
              </Link>
            </Button>
            {!clinic.is_archived && (
              <Button
                variant="outline"
                className="text-yellow-600 hover:text-yellow-700"
              >
                <Archive className="h-4 w-4 mr-2" />
                Archive Clinic
              </Button>
            )}
            {clinic.is_archived && (
              <Button
                variant="outline"
                className="text-green-600 hover:text-green-700"
              >
                Restore Clinic
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Experimental: HERS Subscription */}
      <Card className="border-dashed">
        <CardHeader>
          <div className="flex items-center gap-2">
            <FlaskConical className="h-5 w-5 text-muted-foreground" />
            <div>
              <CardTitle className="text-base">Experimental</CardTitle>
              <CardDescription>HERS Environmental Monitoring</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground mb-4">
            Subscribe this clinic to the HERS platform to receive notifications
            about environmental changes (e.g. air quality, weather events)
            relevant to the clinic's location.
          </p>

          {hersSubscribed === null ? (
            <p className="text-sm text-muted-foreground italic">
              Unable to check subscription status.
            </p>
          ) : hersSubscribed ? (
            <div className="flex items-center gap-3">
              <Badge
                variant="outline"
                className="text-green-600 border-green-600"
              >
                ACTIVE
              </Badge>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:text-destructive"
                onClick={handleHersUnsubscribe}
                disabled={hersLoading}
              >
                {hersLoading && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Deactivate
              </Button>
            </div>
          ) : (
            <Button
              variant="outline"
              onClick={handleHersSubscribe}
              disabled={hersLoading}
            >
              {hersLoading && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
              Subscribe to HERS
            </Button>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
