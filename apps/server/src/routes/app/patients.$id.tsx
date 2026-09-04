import {
  getPatientById,
  softDeletePatientsByIds,
} from "@/lib/server-functions/patients";
import { getPatientVitals } from "@/lib/server-functions/vitals";
import {
  getPatientVisits,
  type VisitWithEvents,
} from "@/lib/server-functions/visits";
import { getPatientPrescriptions } from "@/lib/server-functions/prescriptions";
import { getPatientProblems } from "@/lib/server-functions/patient-problems";
import { Result } from "@/lib/result";
import { createFileRoute, redirect, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import {
  Calendar,
  Phone,
  MapPin,
  LucideUser,
  HeartPulse,
  Wind,
  TestTube2,
} from "lucide-react";
import { format } from "date-fns";
import type PatientVital from "@/models/patient-vital";
import type Patient from "@/models/patient";
import Appointment from "@/models/appointment";
import type Prescription from "@/models/prescription";
import type PatientProblem from "@/models/patient-problem";
import { useEffect, useState, useCallback } from "react";
import { getAppointmentsByPatientId } from "@/lib/server-functions/appointments";
import type Clinic from "@/models/clinic";
import type User from "@/models/user";
import type { Pagination } from "@/lib/server-functions/builders";
import { PatientVitalsCard } from "@/components/patient/PatientVitalsCard";
import { RecentVisitsList } from "@/components/patient/RecentVisitsList";
import { PrescriptionsList } from "@/components/patient/PrescriptionsList";
import { PatientProblemsList } from "@/components/patient/PatientProblemsList";
import { parseCivilDate } from "@/lib/utils";
import { Logger } from "@hikmahealth/js-utils";
import { useQuery } from "@tanstack/react-query";
import type { RiskPrediction } from "../api/patients.$id.risk-profile";

export const Route = createFileRoute("/app/patients/$id")({
  component: RouteComponent,
  loader: async ({ params }) => {
    const patientId = params["id"];

    const emptyPagination: Pagination = {
      offset: 0,
      limit: 10,
      total: 0,
      hasMore: false,
    };

    const result: {
      patient: Patient.EncodedT | null;
      vitals: PatientVital.EncodedT[];
      appointments: {
        appointment: Appointment.EncodedT;
        patient: Patient.EncodedT;
        clinic: Clinic.EncodedT;
        provider: User.EncodedT;
      }[];
      visits: VisitWithEvents[];
      visitsPagination: Pagination;
      prescriptions: Prescription.EncodedT[];
      prescriptionsPagination: Pagination;
      prescriptionStatusCounts: Prescription.StatusCount[];
      problems: PatientProblem.EncodedT[];
      problemsPagination: Pagination;
    } = {
      patient: null,
      vitals: [],
      appointments: [],
      visits: [],
      visitsPagination: emptyPagination,
      prescriptions: [],
      prescriptionsPagination: emptyPagination,
      prescriptionStatusCounts: [],
      problems: [],
      problemsPagination: emptyPagination,
    };
    if (!patientId || patientId === "new") {
      return result;
    }

    try {
      const { patient } = await getPatientById({ data: { id: patientId } });

      if (!patient) {
        return result;
      }

      result.patient = patient;

      const [
        appointmentsRes,
        visitsRes,
        prescriptionsRes,
        problemsRes,
        vitals,
      ] = await Promise.all([
        getAppointmentsByPatientId({ data: { patientId } }).catch((e) => {
          Logger.error({ msg: "Failed to fetch appointments:", e });
          return { data: [], error: e };
        }),
        getPatientVisits({
          data: { patientId, limit: 10, offset: 0, includeEvents: true },
        }).catch((e) => {
          Logger.error({ msg: "Failed to fetch visits:", e });
          return {
            ok: false as const,
            error: {
              _tag: "ServerError" as const,
              message: String(e),
            },
          };
        }),
        getPatientPrescriptions({
          data: { patientId, limit: 10, offset: 0 },
        }).catch((e) => {
          Logger.error({ msg: "Failed to fetch prescriptions:", e });
          return {
            ok: false as const,
            error: {
              _tag: "ServerError" as const,
              message: String(e),
            },
          };
        }),
        getPatientProblems({
          data: { patientId, limit: 5, offset: 0 },
        }).catch((e) => {
          Logger.error({ msg: "Failed to fetch problems:", e });
          return {
            ok: false as const,
            error: {
              _tag: "ServerError" as const,
              message: String(e),
            },
          };
        }),
        getPatientVitals({ data: { patientId } }).catch((e) => {
          Logger.error({ msg: "Failed to fetch vitals:", e });
          return [] as PatientVital.EncodedT[];
        }),
      ]);

      result.appointments = appointmentsRes.data || [];

      const visitsData = Result.getOrElse(visitsRes, {
        items: [] as VisitWithEvents[],
        pagination: emptyPagination,
      });
      result.visits = visitsData.items;
      result.visitsPagination = visitsData.pagination;

      const rxData = Result.getOrElse(prescriptionsRes, {
        items: [] as Prescription.EncodedT[],
        statusCounts: [] as Prescription.StatusCount[],
        pagination: emptyPagination,
      });
      result.prescriptions = rxData.items;
      result.prescriptionsPagination = rxData.pagination;
      result.prescriptionStatusCounts = rxData.statusCounts;

      const problemsData = Result.getOrElse(problemsRes, {
        items: [] as PatientProblem.EncodedT[],
        pagination: emptyPagination,
      });
      result.problems = problemsData.items;
      result.problemsPagination = problemsData.pagination;

      result.vitals = vitals || [];

      return result;
    } catch (error) {
      Logger.error({ msg: "Failed to fetch patient:", error });
      return result;
    }
  },
});

const RISK_TYPE_META = {
  cvd: { label: "Cardiovascular", Icon: HeartPulse },
  respiratory: { label: "Respiratory", Icon: Wind },
} as const;

const RISK_SCORE_VARIANT = {
  high: "destructive",
  medium: "outline",
  low: "secondary",
} as const satisfies Record<string, "destructive" | "outline" | "secondary">;

function RiskRelatedInformation({ id }: { id: string }) {
  const results = useQuery({
    queryKey: ["risk_prediction", id],
    queryFn: (): Promise<RiskPrediction[]> =>
      fetch(`/api/patients/${id}/risk-profile`).then((res) => res.json()),
  });

  // Nothing to show — omit the card entirely
  if (!results.data || results.data.length === 0) {
    return <></>;
  }

  // Group by type, sort descending by recorded_at, keep latest + previous
  const grouped = Object.entries(
    results.data.reduce<Record<string, RiskPrediction[]>>((acc, entry) => {
      const type = entry.value.type;
      if (!acc[type]) acc[type] = [];
      acc[type].push(entry);
      return acc;
    }, {}),
  ).map(([type, entries]) => {
    const sorted = [...entries].sort((a, b) => {
      if (!a.recorded_at) return 1;
      if (!b.recorded_at) return -1;
      return (
        new Date(b.recorded_at).getTime() - new Date(a.recorded_at).getTime()
      );
    });
    return {
      type: type as RiskPrediction["value"]["type"],
      latest: sorted[0],
      previous: sorted[1] ?? null,
    };
  });

  return (
    <Card className="border-yellow-500 [*>[data-slot=card-title]]:text-yellow-900 [*>[data-slot=card-description]]:text-yellow-700">
      <CardHeader>
        <CardTitle className="text-lg flex flex-row gap-3 items-center">
          Environmental Risk Profile
          <span className="bg-yellow-700 text-sm text-yellow-50 px-2.5 rounded-full items-center gap-2 py-0.5 whitespace-nowrap inline-flex flex">
            <TestTube2 className="size-4" /> HERS
          </span>
        </CardTitle>
        <CardDescription>
          Predicted risk levels based on environmental exposure data
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-wrap gap-4">
          {grouped.map(({ type, latest, previous }) => {
            const meta = RISK_TYPE_META[type] ?? RISK_TYPE_META.cvd;
            const { Icon, label } = meta;
            return (
              <div
                key={type}
                className="flex flex-1 min-w-[180px] items-center justify-between gap-4 rounded-lg border p-4"
              >
                <div className="flex items-center gap-2">
                  <Icon className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <p className="text-sm font-medium">{label}</p>
                    {latest.recorded_at && (
                      <p className="text-xs text-muted-foreground">
                        Updated{" "}
                        {format(
                          new Date(latest.recorded_at as string),
                          "MMM dd, yyyy",
                        )}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <Badge
                    variant={
                      RISK_SCORE_VARIANT[latest.value.score] ?? "outline"
                    }
                  >
                    {latest.value.score.toUpperCase()}
                  </Badge>
                  {previous && previous.value.score !== latest.value.score && (
                    <span className="text-xs text-muted-foreground">
                      prev: {previous.value.score.toUpperCase()}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}

function RouteComponent() {
  const {
    patient,
    vitals: initialVitals,
    appointments,
    visits: initialVisits,
    visitsPagination: initialVisitsPag,
    prescriptions: initialPrescriptions,
    prescriptionsPagination: initialRxPag,
    prescriptionStatusCounts: initialRxStatusCounts,
    problems: initialProblems,
    problemsPagination: initialProblemsPag,
  } = Route.useLoaderData();
  const params = Route.useParams();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const patientId = params.id;
  const isEditing = !!patientId && patientId !== "new";
  // Optional-chained: the `!patient` guard is further down, after the hooks, so
  // this runs even when the patient failed to load.
  const patientDateOfBirth = parseCivilDate(patient?.date_of_birth);
  const [mostRecentVital, setMostRecentVital] = useState<
    typeof PatientVital.PatientVitalSchema.Encoded | null
  >(null);

  const [visits, setVisits] = useState(initialVisits);
  const [visitsPag, setVisitsPag] = useState(initialVisitsPag);
  const [visitsLoading, setVisitsLoading] = useState(false);

  const [prescriptions, setPrescriptions] = useState(initialPrescriptions);
  const [rxPag, setRxPag] = useState(initialRxPag);
  const [rxStatusCounts, setRxStatusCounts] = useState(initialRxStatusCounts);
  const [rxLoading, setRxLoading] = useState(false);

  const [problems, setProblems] = useState(initialProblems);
  const [problemsPag, setProblemsPag] = useState(initialProblemsPag);
  const [problemsLoading, setProblemsLoading] = useState(false);

  useEffect(() => {
    setVisits(initialVisits);
    setVisitsPag(initialVisitsPag);
  }, [initialVisits, initialVisitsPag]);

  useEffect(() => {
    setPrescriptions(initialPrescriptions);
    setRxPag(initialRxPag);
    setRxStatusCounts(initialRxStatusCounts);
  }, [initialPrescriptions, initialRxPag, initialRxStatusCounts]);

  useEffect(() => {
    setProblems(initialProblems);
    setProblemsPag(initialProblemsPag);
  }, [initialProblems, initialProblemsPag]);

  useEffect(() => {
    if (initialVitals && initialVitals.length > 0) {
      setMostRecentVital(initialVitals[0]);
    }
  }, [initialVitals]);

  const handleVisitsPageChange = useCallback(
    async (offset: number) => {
      if (!patientId) return;
      setVisitsLoading(true);
      try {
        const res = await getPatientVisits({
          data: { patientId, offset, limit: 10, includeEvents: true },
        });
        if (res.ok) {
          setVisits(res.data.items);
          setVisitsPag(res.data.pagination);
        }
      } catch (e) {
        Logger.error({ msg: "Failed to fetch visits page:", e });
      } finally {
        setVisitsLoading(false);
      }
    },
    [patientId],
  );

  const handleRxPageChange = useCallback(
    async (offset: number) => {
      if (!patientId) return;
      setRxLoading(true);
      try {
        const res = await getPatientPrescriptions({
          data: { patientId, offset, limit: 10 },
        });
        if (res.ok) {
          setPrescriptions(res.data.items);
          setRxPag(res.data.pagination);
          setRxStatusCounts(res.data.statusCounts ?? []);
        }
      } catch (e) {
        Logger.error({ msg: "Failed to fetch prescriptions page:", e });
      } finally {
        setRxLoading(false);
      }
    },
    [patientId],
  );

  const handleProblemsPageChange = useCallback(
    async (offset: number) => {
      if (!patientId) return;
      setProblemsLoading(true);
      try {
        const res = await getPatientProblems({
          data: { patientId, offset, limit: 5 },
        });
        if (res.ok) {
          setProblems(res.data.items);
          setProblemsPag(res.data.pagination);
        }
      } catch (e) {
        Logger.error({ msg: "Failed to fetch problems page:", e });
      } finally {
        setProblemsLoading(false);
      }
    },
    [patientId],
  );

  if (!isEditing || !patient) {
    toast.error("Patient not found");
    throw redirect({
      to: "/app/patients",
      from: "/app/patients/$",
      state: {},
      replace: true,
    });
  }

  // The DOB is a civil date, so it is parsed from local parts to match the
  // local getters below — see `parseCivilDate`.
  const calculateAge = (dob: Date | string | undefined) => {
    const birthDate = parseCivilDate(dob);
    if (!birthDate) return "Unknown";
    const today = new Date();
    let age = today.getFullYear() - birthDate.getFullYear();
    const monthDiff = today.getMonth() - birthDate.getMonth();
    if (
      monthDiff < 0 ||
      (monthDiff === 0 && today.getDate() < birthDate.getDate())
    ) {
      age--;
    }
    return age;
  };

  const getInitials = (givenName?: string, surname?: string) => {
    const first = givenName?.[0] || "";
    const last = surname?.[0] || "";
    return (first + last).toUpperCase() || "PT";
  };

  const handleEditAppointment = (appointmentId: Appointment.EncodedT["id"]) => {
    navigate({
      to: `/app/appointments/edit/${appointmentId}`,
    });
  };

  const handleDeletePatient = async (patientId: string) => {
    if (confirm("Are you sure you want to delete this patient?")) {
      const { error, success } = await softDeletePatientsByIds({
        data: { ids: [patientId] },
      });

      if (!error && success) {
        toast.success("Patient deleted successfully");
        window.history.back();
        router.invalidate({ sync: true });
      } else {
        toast.error("Failed to delete patient");
      }
    }
  };

  return (
    <div className="container mx-auto p-6 space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between">
            <div className="flex items-center space-x-4">
              <Avatar className="h-20 w-20">
                <AvatarImage src={patient.photo_url || undefined} />
                <AvatarFallback className="text-lg">
                  {getInitials(patient.given_name, patient.surname)}
                </AvatarFallback>
              </Avatar>
              <div>
                <CardTitle className="text-2xl">
                  {patient.given_name || "—"} {patient.surname || "—"}
                </CardTitle>
                <CardDescription className="mt-1">
                  Patient ID: {patient.external_patient_id || patient.id}
                </CardDescription>
                <div className="flex items-center gap-4 mt-2">
                  <Badge variant="outline" className="font-normal">
                    <LucideUser className="mr-1 h-3 w-3" />
                    {patient.sex || "Unknown"}
                  </Badge>
                  <Badge variant="outline" className="font-normal">
                    <Calendar className="mr-1 h-3 w-3" />
                    Age:{" "}
                    {patient.date_of_birth
                      ? calculateAge(patient.date_of_birth)
                      : "Unknown"}
                  </Badge>
                </div>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      <RiskRelatedInformation id={patientId} />

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Demographics</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Date of Birth</span>
              <span className="font-medium">
                {patientDateOfBirth
                  ? format(patientDateOfBirth, "MMM dd, yyyy")
                  : "—"}
              </span>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Sex</span>
              <span className="font-medium">{patient.sex || "—"}</span>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Citizenship</span>
              <span className="font-medium">{patient.citizenship || "—"}</span>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Government ID</span>
              <span className="font-medium">
                {patient.government_id || "—"}
              </span>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-lg">Contact Information</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center">
                <Phone className="mr-2 h-4 w-4" />
                Phone
              </span>
              <span className="font-medium">{patient.phone || "—"}</span>
            </div>
            <Separator />
            <div className="flex items-center justify-between">
              <span className="text-muted-foreground flex items-center">
                <MapPin className="mr-2 h-4 w-4" />
                Hometown
              </span>
              <span className="font-medium">{patient.hometown || "—"}</span>
            </div>
            <Separator />
            <div className="flex justify-between">
              <span className="text-muted-foreground">Camp</span>
              <span className="font-medium">{patient.camp || "—"}</span>
            </div>
          </CardContent>
        </Card>
      </div>

      <PatientVitalsCard vital={mostRecentVital} />

      <Tabs defaultValue="visits" className="w-full">
        <TabsList className="grid w-full grid-cols-5">
          <TabsTrigger value="visits">Recent Visits</TabsTrigger>
          <TabsTrigger value="problems">Problems</TabsTrigger>
          <TabsTrigger value="vitals">Vital History</TabsTrigger>
          <TabsTrigger value="prescriptions">Prescriptions</TabsTrigger>
          <TabsTrigger value="appointments">Appointments</TabsTrigger>
        </TabsList>

        <TabsContent value="visits">
          <RecentVisitsList
            visits={visits}
            pagination={visitsPag}
            onPageChange={handleVisitsPageChange}
            loading={visitsLoading}
          />
        </TabsContent>

        <TabsContent value="problems">
          <PatientProblemsList
            problems={problems}
            pagination={problemsPag}
            onPageChange={handleProblemsPageChange}
            loading={problemsLoading}
          />
        </TabsContent>

        <TabsContent value="vitals">
          <Card>
            <CardHeader>
              <CardTitle>Vital Signs History</CardTitle>
              <CardDescription>Historical vital measurements</CardDescription>
            </CardHeader>
            <CardContent>
              {initialVitals && initialVitals.length > 0 ? (
                <div className="space-y-4">
                  {initialVitals.slice(0, 5).map((vital) => (
                    <div key={vital.id} className="border rounded-lg p-4">
                      <div className="flex justify-between items-start">
                        <div className="space-y-1">
                          <p className="text-sm font-medium">
                            {format(
                              new Date(vital.timestamp),
                              "MMM dd, yyyy HH:mm",
                            )}
                          </p>
                          <div className="flex gap-4 text-sm text-muted-foreground">
                            {vital.systolic_bp && vital.diastolic_bp && (
                              <span>
                                BP: {vital.systolic_bp}/{vital.diastolic_bp}
                              </span>
                            )}
                            {vital.heart_rate && (
                              <span>HR: {vital.heart_rate}</span>
                            )}
                            {vital.pulse_rate && (
                              <span>PR: {vital.pulse_rate}</span>
                            )}
                            {vital.temperature_celsius && (
                              <span>Temp: {vital.temperature_celsius}°C</span>
                            )}
                            {vital.oxygen_saturation && (
                              <span>O₂: {vital.oxygen_saturation}%</span>
                            )}
                            {vital.pain_level && (
                              <span>Pain: {vital.pain_level}/10</span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-8 text-muted-foreground">
                  No vital history available
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="prescriptions">
          <PrescriptionsList
            prescriptions={prescriptions}
            pagination={rxPag}
            statusCounts={rxStatusCounts}
            onPageChange={handleRxPageChange}
            loading={rxLoading}
          />
        </TabsContent>

        <TabsContent value="appointments">
          <Card>
            <CardHeader>
              <CardTitle>Appointments</CardTitle>
              <CardDescription>Upcoming and past appointments</CardDescription>
            </CardHeader>
            <CardContent>
              {appointments.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  No appointments scheduled
                </div>
              )}
              {appointments.map(({ appointment, provider, clinic }) => (
                <div
                  key={appointment.id}
                  className="border rounded-lg p-4 mb-4 last:mb-0"
                >
                  <div className="flex justify-between items-start mb-3">
                    <div className="space-y-1">
                      <p className="font-medium">
                        {format(
                          new Date(appointment.timestamp),
                          "MMM dd, yyyy",
                        )}{" "}
                        at {format(new Date(appointment.timestamp), "HH:mm")}
                      </p>
                      <div className="flex gap-2">
                        <Badge
                          variant={
                            appointment.status === "completed"
                              ? "default"
                              : appointment.status === "confirmed"
                                ? "secondary"
                                : appointment.status === "cancelled"
                                  ? "destructive"
                                  : appointment.status === "checked_in"
                                    ? "outline"
                                    : "secondary"
                          }
                        >
                          {appointment.status || "Pending"}
                        </Badge>
                        {appointment.duration && (
                          <Badge variant="outline">
                            {appointment.duration} min
                          </Badge>
                        )}
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleEditAppointment(appointment.id)}
                        >
                          Edit
                        </Button>
                      </div>
                    </div>
                    <div className="text-right text-sm">
                      <p className="text-muted-foreground">Appointment ID</p>
                      <p className="font-mono text-xs">
                        {appointment.id.slice(0, 8)}
                      </p>
                    </div>
                  </div>

                  {appointment.notes && (
                    <div className="mb-3">
                      <p className="text-sm text-muted-foreground mb-1">
                        Notes
                      </p>
                      <p className="text-sm">{appointment.notes}</p>
                    </div>
                  )}

                  <div className="grid grid-cols-2 gap-2 text-sm">
                    {appointment.clinic_id && (
                      <div>
                        <span className="text-muted-foreground">Clinic: </span>
                        <span className="font-medium">
                          {clinic.name || "Unknown"}
                        </span>
                      </div>
                    )}
                    {appointment.provider_id && (
                      <div>
                        <span className="text-muted-foreground">
                          Provider:{" "}
                        </span>
                        <span className="font-medium">
                          {provider.name || "Unknown"}
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Danger Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-lg text-red-700">
              Danger Section
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent>
          <h3 className="text-md font-semibold">Delete Patient</h3>
          <Button
            variant="outline"
            onClick={() => handleDeletePatient(patient.id)}
            className=""
          >
            I am sure I want to delete this Patient.
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
