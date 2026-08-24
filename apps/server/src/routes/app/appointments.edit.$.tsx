import { createFileRoute } from "@tanstack/react-router";
import { getAppointmentById } from "@/lib/server-functions/appointments";
import Appointment from "@/models/appointment";
import { useForm } from "react-hook-form";
import { createServerFn } from "@tanstack/react-start";
import Select from "react-select";
import { useEffect, useState } from "react";
import ClinicDepartment from "@/models/clinic-department";
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { toast } from "sonner";
import { v1 as uuidV1 } from "uuid";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { CalendarIcon } from "lucide-react";
import { format, formatDate } from "date-fns";
import { cn } from "@/lib/utils";
import { Result } from "@/lib/result";
import User from "@/models/user";
import Clinic from "@/models/clinic";
import { SelectInput } from "@/components/select-input";
import { getAllClinics, getClinicById } from "@/lib/server-functions/clinics";
import { getAllUsers } from "@/lib/server-functions/users";
import { getCurrentUser } from "@/lib/server-functions/auth";
import { PatientSearchSelect } from "@/components/patient-search-select";
import { getPatientById } from "@/lib/server-functions/patients";
import type Patient from "@/models/patient";
import If from "@/components/if";
import { Checkbox } from "@/components/ui/checkbox";
import { Logger } from "@hikmahealth/js-utils";
import { adminMiddleware } from "@/middleware/auth";

const saveAppointment = createServerFn({ method: "POST" })
  .validator(
    (data: {
      appointment: Appointment.EncodedT;
      id: string | null;
      currentUserName: string;
    }) => data,
  )
  .middleware([adminMiddleware])
  .handler(async ({ data }) => {
    const { appointment, id, currentUserName } = data;
    Logger.log({ appointment, id, currentUserName });
    return await Appointment.API.save(id, appointment, currentUserName);
  });

export const Route = createFileRoute("/app/appointments/edit/$")({
  component: RouteComponent,
  loader: async ({ params, location }) => {
    const appointmentId = params["_splat"];

    let patientId: string | null = null;
    if (!appointmentId || typeof appointmentId !== "string") {
      patientId =
        (location.search as { patientId?: string })?.patientId || null;
    }

    const result: {
      appointment: Appointment.EncodedT | null;
      users: User.EncodedT[];
      clinics: Clinic.EncodedT[];
      currentUser: User.EncodedT | null;
      patient: Patient.EncodedT | null;
    } = {
      appointment: null,
      users: [],
      clinics: [],
      currentUser: null,
      patient: null,
    };
    if (appointmentId) {
      result.appointment = (await getAppointmentById({
        data: { id: appointmentId },
      })) as Appointment.EncodedT | null;
      patientId = result?.appointment?.patient_id || null;
    }

    result.users = (await getAllUsers()) as User.EncodedT[];
    result.clinics = Result.getOrElse(
      await getAllClinics(),
      [],
    ) as Clinic.EncodedT[];
    result.currentUser = (await getCurrentUser()) as User.EncodedT | null;
    if (patientId) {
      const patientResult = await getPatientById({
        data: { id: patientId },
      });
      result.patient = patientResult?.patient || null;
    }
    return result;
  },
});

const durationOptions = [
  { label: "Unknown", value: 0 },
  { label: "15 minutes", value: 15 },
  { label: "30 minutes", value: 30 },
  { label: "45 minutes", value: 45 },
  { label: "1 hour", value: 60 },
  { label: "2 hours", value: 60 * 2 },
  { label: "3 hours", value: 60 * 3 },
  { label: "8 hours", value: 60 * 8 },
];

const reasonOptions = [
  // { label: "Walk-in", value: "walk-in" },
  { label: "Doctor's Visit", value: "doctor-visit" },
  { label: "Screening", value: "screening" },
  { label: "Referral", value: "referral" },
  { label: "Checkup", value: "checkup" },
  { label: "Follow-up", value: "follow-up" },
  { label: "Counselling", value: "counselling" },
  { label: "Procedure", value: "procedure" },
  { label: "Investigation", value: "investigation" },
  { label: "Other", value: "other" },
];

const statusOptions = [
  { label: "Pending", value: "pending" },
  { label: "Confirmed", value: "confirmed" },
  { label: "Cancelled", value: "cancelled" },
  { label: "Completed", value: "completed" },
  { label: "Checked In", value: "checked_in" },
];

const DEFAULT_FORM_VALUES: Partial<Appointment.EncodedT> = {
  provider_id: null,
  clinic_id: "",
  patient_id: "",
  user_id: "",
  current_visit_id: "",
  fulfilled_visit_id: null,
  timestamp: new Date(),
  duration: 0,
  reason: "",
  notes: "",
  status: "pending" as const,
  metadata: {},
  departments: [],
  is_walk_in: false,
  is_deleted: false,
  created_at: new Date(),
  updated_at: new Date(),
  last_modified: new Date(),
  server_created_at: new Date(),
  deleted_at: null,
};

function RouteComponent() {
  const {
    appointment,
    users: providers,
    clinics,
    currentUser,
    patient,
  } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const params = Route.useParams();
  const appointmentId = params._splat;
  const isEditing = !!appointmentId;

  Logger.log({ appointment });

  const [submitting, setSubmitting] = useState(false);
  const [availableDepartments, setAvailableDepartments] = useState<
    ClinicDepartment.EncodedT[]
  >([]);

  const form = useForm<Appointment.EncodedT>({
    defaultValues: {
      ...DEFAULT_FORM_VALUES,
      ...appointment,
      patient_id: patient?.id || "",
      provider_id: currentUser?.id || "",
    } as Appointment.EncodedT,
  });

  const onSubmit = async (values: Appointment.EncodedT) => {
    if (!currentUser || submitting) return;
    setSubmitting(true);
    try {
      await saveAppointment({
        data: {
          appointment: {
            ...values,
            id: appointment?.id || uuidV1(),
            user_id: currentUser?.id || "",
          },
          id: isEditing ? appointment?.id || null : null,
          currentUserName: currentUser?.name || "",
        },
      });

      toast.success(
        isEditing
          ? "Appointment updated successfully"
          : "Appointment created successfully",
      );
      navigate({ to: "/app/appointments" });
    } catch (error) {
      Logger.error({ msg: "Error saving appointment:", error });
      toast.error("Failed to save appointment");
    } finally {
      setSubmitting(false);
    }
  };

  Logger.log({ mgs: "Selected Clinic:", clinicId: form.watch("clinic_id") });

  const selectedClinic = form.watch("clinic_id");

  useEffect(() => {
    const handleDepartmentsUpdate = async () => {
      if (selectedClinic) {
        try {
          const clinicResponse = await getClinicById({
            data: { id: selectedClinic },
          });
          if (clinicResponse.ok && clinicResponse.data.departments) {
            setAvailableDepartments(clinicResponse.data.departments);

            const currentDepartments = form.getValues("departments");
            if (!currentDepartments || currentDepartments.length === 0) {
              // Don't auto-populate departments, let user select them
              form.setValue("departments", []);
            }
          }
        } catch (error) {
          Logger.error({ msg: "Failed to fetch departments:", error });
          setAvailableDepartments([]);
        }
      } else {
        setAvailableDepartments([]);
        form.setValue("departments", []);
      }
    };

    handleDepartmentsUpdate();
  }, [selectedClinic]);

  // TODO: Default provider and clinic selection based on who is the current use

  Logger.log(form.watch());

  return (
    <div className="">
      <div className="flex-1 overflow-y-auto p-6">
        <div className="max-w-2xl">
          <h1 className="text-xl font-bold mb-2">
            {isEditing ? "Edit Appointment" : "Create New Appointment"}
          </h1>
          <p className="text-muted-foreground mb-6">
            {isEditing
              ? "Update the appointment information below"
              : "Enter the details for the new appointment"}
          </p>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
              <div className="grid grid-cols-1 gap-4">
                <FormField
                  control={form.control}
                  name="is_walk_in"
                  render={({ field }) => (
                    <FormItem>
                      <FormControl>
                        <Checkbox
                          label="Walk-in"
                          description="Is this a walk-in appointment?"
                          checked={field.value}
                          onCheckedChange={field.onChange}
                        />
                      </FormControl>
                    </FormItem>
                  )}
                />
              </div>
              <PatientSearchSelect
                onChange={(patient) =>
                  form.setValue("patient_id", patient?.id || "")
                }
                value={patient?.id || ""}
                defaultValue={patient?.id || ""}
                defaultPatients={patient ? [patient] : []}
                label="Patient"
                clearable
                description="Select the patient for the appointment"
                withAsterisk
              />
              <FormField
                control={form.control}
                name="provider_id"
                render={({ field }) => (
                  <SelectInput
                    label="Provider"
                    data={providers.map((provider) => ({
                      label: provider.name,
                      value: provider.id,
                    }))}
                    value={field.value || ""}
                    onChange={field.onChange}
                    clearable
                    className="w-full"
                  />
                )}
              />

              <FormField
                control={form.control}
                name="clinic_id"
                render={({ field }) => (
                  <SelectInput
                    label="Clinic"
                    data={clinics.map((clinic) => ({
                      label: clinic.name || "Unknown",
                      value: clinic.id,
                    }))}
                    value={field.value || ""}
                    onChange={field.onChange}
                    clearable
                    className="w-full"
                  />
                )}
              />

              <If show={selectedClinic.length > 0}>
                <FormField
                  control={form.control}
                  name="departments"
                  render={({ field }) => {
                    const selectedDepartments = field.value || [];

                    const departmentOptions = availableDepartments.map(
                      (dept) => ({
                        value: dept.id,
                        label: dept.name,
                        department: dept,
                      }),
                    );

                    const currentValue = selectedDepartments.map((dept) => ({
                      value: dept.id,
                      label:
                        availableDepartments.find((d) => d.id === dept.id)
                          ?.name || dept.id,
                      department: availableDepartments.find(
                        (d) => d.id === dept.id,
                      ),
                    }));

                    return (
                      <FormItem>
                        <FormLabel>Departments</FormLabel>
                        <Select
                          isMulti
                          options={departmentOptions}
                          value={currentValue}
                          onChange={(selected) => {
                            const newDepartments = (selected || []).map(
                              (option) => ({
                                id: option.value,
                                name: option.label,
                                seen_at: null,
                                seen_by: null,
                                status: "pending" as const,
                              }),
                            );

                            // Preserve existing data for departments that were already selected
                            const updatedDepartments = newDepartments.map(
                              (newDept) => {
                                const existing = selectedDepartments.find(
                                  (d: any) => d.id === newDept.id,
                                );
                                if (existing) {
                                  return existing; // Keep existing data
                                }
                                return newDept; // New department with defaults
                              },
                            );

                            field.onChange(updatedDepartments);
                          }}
                          placeholder="Select departments..."
                          className="basic-multi-select"
                          classNamePrefix="select"
                          // styles={{
                          //   control: (base) => ({
                          //     ...base,
                          //     minHeight: "36px",
                          //     backgroundColor: "hsl(var(--background))",
                          //     borderColor: "hsl(var(--border))",
                          //     "&:hover": {
                          //       borderColor: "hsl(var(--border))",
                          //     },
                          //   }),
                          //   menu: (base) => ({
                          //     ...base,
                          //     backgroundColor: "hsl(var(--background))",
                          //     border: "1px solid hsl(var(--border))",
                          //   }),
                          //   option: (base, state) => ({
                          //     ...base,
                          //     backgroundColor: state.isFocused
                          //       ? "hsl(var(--accent))"
                          //       : "hsl(var(--background))",
                          //     color: "hsl(var(--foreground))",
                          //     cursor: "pointer",
                          //     "&:hover": {
                          //       backgroundColor: "hsl(var(--accent))",
                          //     },
                          //   }),
                          //   multiValue: (base) => ({
                          //     ...base,
                          //     backgroundColor: "hsl(var(--secondary))",
                          //   }),
                          //   multiValueLabel: (base) => ({
                          //     ...base,
                          //     color: "hsl(var(--secondary-foreground))",
                          //   }),
                          //   multiValueRemove: (base) => ({
                          //     ...base,
                          //     color: "hsl(var(--secondary-foreground))",
                          //     "&:hover": {
                          //       backgroundColor: "hsl(var(--destructive))",
                          //       color: "hsl(var(--destructive-foreground))",
                          //     },
                          //   }),
                          //   input: (base) => ({
                          //     ...base,
                          //     color: "hsl(var(--foreground))",
                          //   }),
                          //   placeholder: (base) => ({
                          //     ...base,
                          //     color: "hsl(var(--muted-foreground))",
                          //   }),
                          // }}
                        />
                        <FormDescription>
                          Select the departments this appointment should be
                          routed through
                        </FormDescription>
                        <FormMessage />
                      </FormItem>
                    );
                  }}
                />
              </If>

              <FormField
                control={form.control}
                name="timestamp"
                render={({ field }) => (
                  <FormItem className="flex flex-col">
                    <FormLabel>
                      Date and Time (current time is{" "}
                      {formatDate(new Date(), "PPP HH:mm")})
                    </FormLabel>
                    <Popover>
                      <PopoverTrigger asChild>
                        <FormControl>
                          <Button
                            variant="outline"
                            className={cn(
                              "w-full pl-3 text-left font-normal",
                              !field.value && "text-muted-foreground",
                            )}
                          >
                            {field.value ? (
                              format(new Date(field.value), "PPP HH:mm")
                            ) : (
                              <span>Pick a date and time</span>
                            )}
                            <CalendarIcon className="ml-auto h-4 w-4 opacity-50" />
                          </Button>
                        </FormControl>
                      </PopoverTrigger>
                      <PopoverContent className="w-auto p-0" align="start">
                        <Calendar
                          mode="single"
                          selected={new Date(field.value)}
                          onSelect={(date) => {
                            if (date) {
                              const currentDate = new Date(field.value);
                              date.setHours(currentDate.getHours());
                              date.setMinutes(currentDate.getMinutes());
                              field.onChange(date);
                            }
                          }}
                          initialFocus
                        />
                        <div className="p-3 border-t border-border">
                          <Input
                            type="time"
                            value={format(new Date(field.value), "HH:mm")}
                            onChange={(e) => {
                              const [hours, minutes] = e.target.value
                                .split(":")
                                .map(Number);
                              const date = new Date(field.value);
                              date.setHours(hours);
                              date.setMinutes(minutes);
                              field.onChange(date);
                            }}
                          />
                        </div>
                      </PopoverContent>
                    </Popover>
                    <If show={form.watch("is_walk_in")}>
                      <FormDescription>
                        Walk-ins do not require a date time to be set. They are
                        scheduled on a first-come, first-served basis.
                        <FormMessage />
                      </FormDescription>
                    </If>
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="duration"
                render={({ field }) => (
                  <SelectInput
                    data={durationOptions.map((option) => ({
                      label: option.label,
                      value: option.value.toString(),
                    }))}
                    value={field.value.toString()}
                    onChange={(value) => field.onChange(Number(value))}
                    placeholder="Select duration"
                    className="w-full"
                    label="Duration"
                  />
                )}
              />

              <FormField
                control={form.control}
                name="reason"
                render={({ field }) => (
                  <SelectInput
                    label="Reason"
                    data={reasonOptions.map((option) => ({
                      label: option.label,
                      value: option.value,
                    }))}
                    value={field.value || ""}
                    onChange={field.onChange}
                    placeholder="Select reason"
                    className="w-full"
                  />
                )}
              />

              <FormField
                control={form.control}
                name="status"
                render={({ field }) => (
                  <SelectInput
                    label="Status"
                    data={statusOptions.map((option) => ({
                      label: option.label,
                      value: option.value,
                    }))}
                    value={field.value || ""}
                    onChange={field.onChange}
                    placeholder="Select status"
                    className="w-full"
                  />
                )}
              />

              <FormField
                control={form.control}
                name="notes"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Notes</FormLabel>
                    <FormControl>
                      <Textarea
                        placeholder="Add any additional notes here"
                        className="resize-none"
                        {...field}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="flex gap-3">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => navigate({ to: "/app/appointments" })}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={submitting}>
                  {submitting
                    ? "Saving..."
                    : isEditing
                      ? "Update Appointment"
                      : "Create Appointment"}
                </Button>
              </div>
            </form>
          </Form>
        </div>
      </div>
    </div>
  );
}
