import { createFileRoute, Link, useRouter } from "@tanstack/react-router";
import Patient from "@/models/patient";
import * as React from "react";
import {
  LucideBox,
  LucideCalculator,
  LucideCalendar,
  LucideCalendarPlus,
  LucideChevronDown,
  LucideDownload,
  LucideFilter,
  LucideLink,
  LucideTrash,
} from "lucide-react";
import { Option } from "effect";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

import { getPatientRegistrationForm } from "@/lib/server-functions/patient-registration-forms";
import {
  getAllPatients,
  searchPatients,
  softDeletePatientsByIds,
} from "@/lib/server-functions/patients";
import { getAllClinics } from "@/lib/server-functions/clinics";
import { Result } from "@/lib/result";
import type Clinic from "@/models/clinic";
import PatientRegistrationForm from "@/models/patient-registration-form";
import { createServerFn } from "@tanstack/react-start";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import { truncate } from "es-toolkit/compat";
import { getCurrentUser } from "@/lib/server-functions/auth";

import type ExcelJS from "exceljs";
import Event from "@/models/event";
import EventForm from "@/models/event-form";
import { format } from "date-fns";
import User from "@/models/user";
import { toast } from "sonner";
import PatientProblem from "@/models/patient-problem";
import PatientVital from "@/models/patient-vital";
import { safeJSONParse } from "@/lib/utils";
import { Checkbox } from "@/components/ui/checkbox";
import { useMap } from "usehooks-ts";
import If from "@/components/if";
import { DatePickerInput } from "@/components/date-picker-input";
import Select from "react-select";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

import { forEach } from "ramda";
import { useEffect } from "react";
import { useImmerReducer } from "use-immer";
import { Logger } from "@hikmahealth/js-utils";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  EXPIRY_DAYS_MIN,
  expiryDaysMax,
  ACCESS_GRANT_SCOPES,
} from "@/lib/access-grant-scopes";
import {
  type ExportAccessGrantSummary,
  createAttachmentExportGrant,
  listAttachmentExportGrants,
  revokeAttachmentExportGrant,
} from "@/lib/server-functions/export-access";
import {
  type AttachmentColumnLayout,
  type AttachmentLinkContext,
  attachmentColumnHeaders,
  attachmentLinksForField,
  attachmentOverflowCount,
  hasFileField,
  planAttachmentColumns,
  readExportAttachments,
} from "@/lib/export-attachment-links";

const getAllPatientsForExport = createServerFn({ method: "GET" })
  .validator((data: { includeDeletedForms: boolean }) => data)
  .handler(async ({ data }) => {
    const currentUser = await getCurrentUser();
    if (!currentUser || currentUser.role !== User.ROLES.SUPER_ADMIN) {
      throw new Error("Unauthorized");
    }
    const { patients } = await Patient.API.getAllWithAttributes({
      includeCount: false,
    });
    const eventForms = await EventForm.API.getAll({
      includeDeleted: data.includeDeletedForms,
    });
    const exportEvents = await Event.API.getAllForExport();
    const vitals = await PatientVital.API.getAll();
    const problems = await PatientProblem.getAll();
    return { patients, exportEvents, eventForms, vitals, problems };
  });

// Same shape as getAllPatientsForExport, scoped to the search filters.
const getFilteredPatientsForExport = createServerFn({ method: "GET" })
  .validator(
    (data: {
      searchQuery: string;
      registrationDateStart?: string;
      registrationDateEnd?: string;
      visitsDateStart?: string;
      visitsDateEnd?: string;
      clinicIds?: string[];
      includeDeletedForms: boolean;
    }) => data,
  )
  .handler(async ({ data }) => {
    const currentUser = await getCurrentUser();
    if (!currentUser || currentUser.role !== User.ROLES.SUPER_ADMIN) {
      throw new Error("Unauthorized");
    }
    const { patients } = await Patient.API.search({
      searchQuery: data.searchQuery,
      includeCount: false,
      registrationDateStart: data.registrationDateStart,
      registrationDateEnd: data.registrationDateEnd,
      visitsDateStart: data.visitsDateStart,
      visitsDateEnd: data.visitsDateEnd,
      clinicIds: data.clinicIds,
    });
    const patientIds = new Set(patients.map((p) => p.id));

    const eventForms = await EventForm.API.getAll({
      includeDeleted: data.includeDeletedForms,
    });
    const allEvents = await Event.API.getAllForExport();
    const allVitals = await PatientVital.API.getAll();
    const allProblems = await PatientProblem.getAll();

    return {
      patients,
      exportEvents: allEvents.filter((e) => patientIds.has(e.patient_id)),
      eventForms,
      vitals: allVitals.filter((v) => patientIds.has(v.patient_id)),
      problems: allProblems.filter((p) => patientIds.has(p.patient_id)),
    };
  });

export const Route = createFileRoute("/app/patients/")({
  component: RouteComponent,
  validateSearch: (search: Record<string, unknown>) => ({
    clinicId: typeof search.clinicId === "string" ? search.clinicId : undefined,
  }),
  loaderDeps: ({ search: { clinicId } }) => ({ clinicId }),
  loader: async ({ deps }) => {
    // When navigated with ?clinicId=..., scope the initial list to that clinic.
    const { patients, pagination, error } = deps.clinicId
      ? await searchPatients({
          data: { searchQuery: "", clinicIds: [deps.clinicId] },
        })
      : await getAllPatients();
    const clinicsResult = await getAllClinics();
    const clinics = Result.isOk(clinicsResult) ? clinicsResult.data : [];

    return {
      currentUser: await getCurrentUser(),
      patients: patients,
      pagination,
      clinics,
      patientRegistrationForm: await getPatientRegistrationForm(),
    };
  },
});

type SearchState = {
  searchQuery: string;
  clinicIds: string[];
  registrationDate: [Date | null, Date | null]; // Start date, End date
  visitsInDateRange: [Date | null, Date | null];
};

const initialSearchState: SearchState = {
  searchQuery: "",
  clinicIds: [],
  registrationDate: [null, null],
  visitsInDateRange: [null, null],
};

type ExportScope = "all" | "filtered";

type ExportOptions = {
  linkExpiryDays: number;
  includeDeletedForms: boolean;
};

/**
 * What the export server functions return. Their inferred type collapses to
 * `unknown` because the encoded patient's open-ended `metadata` fails
 * TanStack's serializability check, so call sites assert this back.
 */
type ExportData = {
  patients: (typeof Patient.PatientWithAttributesSchema.Encoded)[];
  exportEvents: (Event.EncodedT & { patient?: Partial<Patient.EncodedT> })[];
  eventForms: EventForm.EncodedT[];
  vitals: PatientVital.EncodedT[];
  problems: PatientProblem.EncodedWithPatientName[];
};

const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  linkExpiryDays: 7,
  includeDeletedForms: false,
};

type SearchAction =
  | { type: "update-search-query"; payload: string }
  | { type: "update-clinic-ids"; payload: string[] }
  | { type: "update-registration-date-start"; payload: Date | null }
  | { type: "update-registration-date-end"; payload: Date | null }
  | { type: "update-visits-date-start"; payload: Date | null }
  | { type: "update-visits-date-end"; payload: Date | null }
  | { type: "reset" };

function searchReducer(draft: SearchState, action: SearchAction) {
  switch (action.type) {
    case "update-search-query":
      draft.searchQuery = action.payload;
      break;
    case "update-clinic-ids":
      draft.clinicIds = action.payload;
      break;
    case "update-registration-date-start":
      draft.registrationDate[0] = action.payload;
      break;
    case "update-registration-date-end":
      draft.registrationDate[1] = action.payload;
      break;
    case "update-visits-date-start":
      draft.visitsInDateRange[0] = action.payload;
      break;
    case "update-visits-date-end":
      draft.visitsInDateRange[1] = action.payload;
      break;
    case "reset":
      return initialSearchState;
  }
}

function RouteComponent() {
  const {
    currentUser,
    patients,
    pagination,
    patientRegistrationForm,
    clinics,
  } = Route.useLoaderData();
  const { clinicId: clinicIdFromUrl } = Route.useSearch();

  const [patientsList, setPatientsList] =
    React.useState<(typeof Patient.PatientWithAttributesSchema.Encoded)[]>(
      patients,
    );
  const [paginationResults, setPaginationResults] = React.useState<{
    pagination: {
      offset: number;
      limit: number;
      total: number;
      hasMore: boolean;
    };
  }>({
    pagination,
  });
  const navigate = Route.useNavigate();
  const route = useRouter();
  const [currentPage, setCurrentPage] = React.useState(1);
  const [searchState, dispatchSearchAction] = useImmerReducer(searchReducer, {
    ...initialSearchState,
    clinicIds: clinicIdFromUrl ? [clinicIdFromUrl] : [],
  });
  const [loading, setLoading] = React.useState(false);
  const [pendingExport, setPendingExport] = React.useState<ExportScope | null>(
    null,
  );
  const [exportOptions, setExportOptions] = React.useState<ExportOptions>(
    DEFAULT_EXPORT_OPTIONS,
  );
  const [liveGrants, setLiveGrants] = React.useState<
    ExportAccessGrantSummary[] | null
  >(null);

  const [selectedPatients, actions] = useMap<string, string>(); // [patientId, patientName]

  useEffect(() => {
    setPatientsList(patients);
    setPaginationResults({ pagination });
  }, [patients, pagination]);

  useEffect(() => {
    route.invalidate({ sync: true });
  }, []);

  const fields = patientRegistrationForm?.fields.filter((f) => !f.deleted);
  const headers = fields?.map((f) => f.label.en) || [];

  const pageSize = Option.getOrElse(
    Option.fromNullable(paginationResults.pagination.limit),
    () => 10,
  );

  const totalItems = Option.getOrElse(
    Option.fromNullable(paginationResults.pagination.total),
    () => 0,
  );

  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize));

  const hasActiveFilters =
    searchState.searchQuery.trim() !== "" ||
    searchState.clinicIds.length > 0 ||
    searchState.registrationDate[0] !== null ||
    searchState.registrationDate[1] !== null ||
    searchState.visitsInDateRange[0] !== null ||
    searchState.visitsInDateRange[1] !== null;

  const handleSearch = (page = 1) => {
    setLoading(true);
    const offset = (page - 1) * pageSize;

    searchPatients({
      data: {
        searchQuery: searchState.searchQuery,
        offset,
        limit: pageSize,
        registrationDateStart:
          searchState.registrationDate[0]?.toISOString() ?? undefined,
        registrationDateEnd:
          searchState.registrationDate[1]?.toISOString() ?? undefined,
        visitsDateStart:
          searchState.visitsInDateRange[0]?.toISOString() ?? undefined,
        visitsDateEnd:
          searchState.visitsInDateRange[1]?.toISOString() ?? undefined,
        clinicIds:
          searchState.clinicIds.length > 0 ? searchState.clinicIds : undefined,
      },
    })
      .then((res) => {
        if (res.patients) {
          setPatientsList(res.patients);
          setPaginationResults(res);
          setCurrentPage(page);
          window.scrollTo({ top: 0, behavior: "smooth" });
        }
      })
      .finally(() => {
        setLoading(false);
      });
  };

  const handlePageChange = (page: number) => {
    if (page >= 1 && page <= totalPages && page !== currentPage) {
      handleSearch(page);
    }
  };

  // First page, last page, and up to three around the current one.
  const getPageNumbers = () => {
    const firstPage = 1;
    const lastPage = totalPages;

    const nearbyPages = Array.from(
      { length: 3 },
      (_, i) => Math.max(2, currentPage - 1) + i,
    ).filter((page) => page > firstPage && page < lastPage);

    return Array.from(new Set([firstPage, ...nearbyPages, lastPage])).sort(
      (a, b) => a - b,
    );
  };

  const handleToggleSelectedPatients = (
    patientId: string,
    patientName: string,
  ) => {
    const exists = selectedPatients.has(patientId);
    if (exists) {
      actions.remove(patientId);
    } else {
      actions.set(patientId, patientName);
    }
  };

  const handleResetPatientSelection = () => {
    actions.reset();
  };

  const handleDeleteSelectedPatients = async () => {
    const confirmPrompt = `Delete ${selectedPatients.size} patients`;
    if (
      prompt(`Type the phrase "${confirmPrompt}" to confirm`, "") ===
      confirmPrompt
    ) {
      const selectedPatientIds = Array.from(selectedPatients.keys());
      const { error, success } = await softDeletePatientsByIds({
        data: { ids: selectedPatientIds },
      });
      if (success) {
        setPatientsList(
          patientsList.filter(
            (patient) => !selectedPatientIds.includes(patient.id),
          ),
        );
        toast.success(
          `Successfully deleted ${selectedPatientIds.length} patient(s)`,
        );
      }
      if (error) {
        Logger.error(`Error deleting patients ${selectedPatientIds}: ${error}`);
        toast.error(`Error deleting patient(s)`);
      }
      actions.reset();
    } else {
      toast.info("Invalid confirmation phrase. Not deleting patients");
    }
  };

  const addVitalsWorksheet = (
    workbook: ExcelJS.Workbook,
    vitals: PatientVital.EncodedT[],
  ): ExcelJS.Worksheet => {
    const vitalsWorksheet = workbook.addWorksheet("Vitals");
    const columns = {
      id: "ID",
      patient_id: "Patient ID",
      visit_id: "Visit ID",
      timestamp: "Timestamp",
      systolic_bp: "Systolic BP",
      diastolic_bp: "Diastolic BP",
      bp_position: "BP Position",
      height_cm: "Height (cm)",
      weight_kg: "Weight (kg)",
      bmi: "BMI",
      waist_circumference_cm: "Waist Circumference (cm)",
      heart_rate: "Heart Rate",
      pulse_rate: "Pulse Rate",
      oxygen_saturation: "Oxygen Saturation",
      respiratory_rate: "Respiratory Rate",
      temperature_c: "Temperature (°C)",
      pain_level: "Pain Level",
      recorded_by_user_id: "Recorded By User ID",
      created_at: "Created At",
      updated_at: "Updated At",
    };
    const vitalsHeaderRow = Object.values(columns);
    vitalsWorksheet.addRow(vitalsHeaderRow);
    vitalsWorksheet.getRow(1).font = { bold: true };

    const vitalRowData = new Array(vitals.length);

    vitals.forEach((vital) => {
      vitalRowData.push([
        vital.id,
        vital.patient_id,
        vital.visit_id,
        vital.timestamp,
        vital.systolic_bp,
        vital.diastolic_bp,
        vital.bp_position,
        vital.height_cm,
        vital.weight_kg,
        vital.bmi,
        vital.waist_circumference_cm,
        vital.heart_rate,
        vital.pulse_rate,
        vital.oxygen_saturation,
        vital.respiratory_rate,
        vital.temperature_celsius,
        vital.pain_level,
        vital.recorded_by_user_id,
        vital.created_at,
        vital.updated_at,
      ]);
    });

    vitalsWorksheet.addRows(vitalRowData);

    return vitalsWorksheet;
  };

  const addProblemsWorksheet = (
    workbook: ExcelJS.Workbook,
    problems: PatientProblem.EncodedWithPatientName[],
  ): ExcelJS.Worksheet => {
    const worksheet = workbook.addWorksheet("Patient Problems");
    const headerRow = [
      "ID",
      "Patient ID",
      "Given Name",
      "Surname",
      "Visit ID",
      "Code System",
      "Code",
      "Label",
      "Clinical Status",
      "Verification Status",
      "Severity Score",
      "Onset Date",
      "End Date",
      "Recorded By User ID",
      "Created At",
      "Updated At",
    ];
    worksheet.addRow(headerRow);
    worksheet.getRow(1).font = { bold: true };

    const rows: unknown[][] = [];
    problems.forEach((p) => {
      rows.push([
        p.id,
        p.patient_id,
        p.given_name ?? "",
        p.surname ?? "",
        p.visit_id,
        p.problem_code_system,
        p.problem_code,
        p.problem_label,
        p.clinical_status,
        p.verification_status,
        p.severity_score,
        p.onset_date,
        p.end_date,
        p.recorded_by_user_id,
        p.created_at,
        p.updated_at,
      ]);
    });

    worksheet.addRows(rows);
    return worksheet;
  };

  // Shared helpers for building export workbooks
  const addPatientsWorksheet = (
    worksheet: ExcelJS.Worksheet,
    exportPatients: (typeof Patient.PatientWithAttributesSchema.Encoded)[],
  ) => {
    const headerRow = [
      "ID",
      ...headers,
      "Record Created At",
      "Last Updated At",
    ];
    worksheet.addRow(headerRow);
    worksheet.getRow(1).font = { bold: true };
    exportPatients.forEach((patient) => {
      const rowData = [patient.id];
      fields?.forEach((field) => {
        if (field.baseField) {
          rowData.push(
            String(
              PatientRegistrationForm.renderFieldValue(
                field,
                patient[field.column as keyof typeof patient],
              ),
            ),
          );
        } else {
          rowData.push(
            String(
              PatientRegistrationForm.renderFieldValue(
                field,
                patient.additional_attributes[field.id],
              ),
            ),
          );
        }
      });
      rowData.push(format(patient.created_at, "yyyy MMM dd"));
      rowData.push(format(patient.updated_at, "yyyy MMM dd"));
      worksheet.addRow(rowData);
    });
  };

  const addEventFormsWorksheets = (
    workbook: ExcelJS.Workbook,
    eventForms: EventForm.EncodedT[],
    exportEvents: (Event.EncodedT & { patient?: Partial<Patient.EncodedT> })[],
    linkContext: AttachmentLinkContext | null,
  ) => {
    eventForms.forEach((eventForm) => {
      const isDeletedPrefix = eventForm.is_deleted ? "DEL - " : "";
      const worksheetIdSuffix = `${eventForm.id.substring(0, 6)}`;
      const worksheetName = `${isDeletedPrefix}${truncate(eventForm.name, {
        length: 18,
        omission: "..",
      })}(#${worksheetIdSuffix})`.replace(/[*?:\\/\[\]]/g, "-");

      const worksheet = workbook.addWorksheet(worksheetName);
      const extraColumns = {
        patient_id: "Patient ID",
        patient_name: "Patient Name",
        patient_sex: "Patient Sex",
        patient_phone_number: "Patient Phone",
        patient_citizenship: "Patient Citizenship",
        patient_date_of_birth: "Patient Date of Birth",
        visit_id: "Visit ID",
        created_at: "Created At",
      };
      const eventFormFields = safeJSONParse(
        eventForm.form_fields,
        [],
      ) as typeof eventForm.form_fields;
      const formEvents = exportEvents.filter(
        (ev) => ev.form_id === eventForm.id,
      );

      // A cell holds at most one hyperlink, so a file field spans as many
      // columns as its widest answer. Left empty without a link context, which
      // falls file fields back to printing raw resource ids.
      const attachmentLayouts = new Map<string, AttachmentColumnLayout>();
      if (linkContext) {
        eventFormFields?.forEach((field) => {
          if (field.fieldType !== "file") return;
          attachmentLayouts.set(
            field.id,
            planAttachmentColumns(
              formEvents.map(
                (event) =>
                  readExportAttachments(
                    event.form_data.find((f) => f.fieldId === field.id),
                  ).length,
              ),
            ),
          );
        });
      }

      const headerRow = [
        "ID",
        ...(eventFormFields ?? []).flatMap((field) => {
          const layout = attachmentLayouts.get(field.id);
          return layout
            ? attachmentColumnHeaders(field.name, layout)
            : [field.name];
        }),
        ...Object.values(extraColumns),
      ];
      worksheet.addRow(headerRow);
      worksheet.getRow(1).font = { bold: true };

      formEvents.forEach((event) => {
        const rowData: unknown[] = [event.id];
        eventFormFields?.forEach((field) => {
          const fieldData = event.form_data.find((f) => f.fieldId === field.id);
          const layout = attachmentLayouts.get(field.id);
          if (!layout || !linkContext) {
            rowData.push(JSON.stringify(fieldData?.value));
            return;
          }

          const links = attachmentLinksForField({
            ...linkContext,
            eventId: event.id,
            field: fieldData,
          });
          for (let column = 0; column < layout.linkColumns; column++) {
            const link = links[column];
            rowData.push(link ? { text: link.label, hyperlink: link.url } : "");
          }
          if (layout.hasOverflowColumn) {
            const overflow = attachmentOverflowCount(fieldData);
            rowData.push(overflow > 0 ? `+${overflow} more` : "");
          }
        });

        rowData.push(event.patient_id);
        rowData.push(
          `${event?.patient?.given_name || ""} ${event?.patient?.surname || ""}`.trim(),
        );
        rowData.push(event?.patient?.sex || "");
        rowData.push(event?.patient?.phone || "");
        rowData.push(event?.patient?.citizenship || "");
        rowData.push(String(event?.patient?.date_of_birth || ""));
        rowData.push(event.visit_id || "");
        rowData.push(format(event.created_at, "yyyy-MM-dd HH:mm:ss"));
        worksheet.addRow(rowData);
      });
    });
  };

  const autoSizeColumns = (worksheet: ExcelJS.Worksheet) => {
    worksheet.columns?.forEach((column) => {
      let maxLength = 0;
      column?.eachCell?.({ includeEmpty: true }, (cell) => {
        const columnLength = cell.value ? cell.value.toString().length : 10;
        if (columnLength > maxLength) {
          maxLength = columnLength;
        }
      });
      column.width = maxLength < 10 ? 10 : maxLength + 2;
    });
  };

  const downloadWorkbook = async (
    workbook: ExcelJS.Workbook,
    fileName: string,
  ) => {
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const buildExportWorkbook = async (
    exportData: ExportData,
    linkContext: AttachmentLinkContext | null,
  ) => {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    workbook.creator = currentUser?.name ?? "";
    workbook.lastModifiedBy = currentUser?.name ?? "";
    workbook.created = new Date();
    workbook.modified = new Date();

    const patientsSheet = workbook.addWorksheet("Patients List");
    addPatientsWorksheet(patientsSheet, exportData.patients);
    autoSizeColumns(patientsSheet);

    addProblemsWorksheet(workbook, exportData.problems);
    addVitalsWorksheet(workbook, exportData.vitals);
    addEventFormsWorksheets(
      workbook,
      exportData.eventForms,
      exportData.exportEvents,
      linkContext,
    );

    return workbook;
  };

  const runExport = async (scope: ExportScope, options: ExportOptions) => {
    const filtered = scope === "filtered";
    try {
      toast("Export started. Please be patient as this could take some time.", {
        dismissible: true,
        duration: 2000,
      });

      const exportData = (
        filtered
          ? await getFilteredPatientsForExport({
              data: {
                searchQuery: searchState.searchQuery,
                registrationDateStart:
                  searchState.registrationDate[0]?.toISOString() ?? undefined,
                registrationDateEnd:
                  searchState.registrationDate[1]?.toISOString() ?? undefined,
                visitsDateStart:
                  searchState.visitsInDateRange[0]?.toISOString() ?? undefined,
                visitsDateEnd:
                  searchState.visitsInDateRange[1]?.toISOString() ?? undefined,
                clinicIds:
                  searchState.clinicIds.length > 0
                    ? searchState.clinicIds
                    : undefined,
                includeDeletedForms: options.includeDeletedForms,
              },
            })
          : await getAllPatientsForExport({
              data: { includeDeletedForms: options.includeDeletedForms },
            })
      ) as ExportData;

      // No file fields means no attachments to link, so no credential is minted.
      const needsLinks = exportData.eventForms.some((form) =>
        hasFileField(safeJSONParse(form.form_fields, [])),
      );
      const grant = needsLinks
        ? await createAttachmentExportGrant({
            data: { expiryDays: options.linkExpiryDays },
          })
        : null;

      const workbook = await buildExportWorkbook(
        exportData,
        grant
          ? {
              baseUrl: window.location.origin,
              token: grant.token,
              tokenParam: grant.tokenParam,
            }
          : null,
      );
      const today = new Date().toISOString().split("T")[0];
      const fileName = filtered
        ? `patients_filtered_export_${today}.xlsx`
        : `patients_export_${today}.xlsx`;
      await downloadWorkbook(workbook, fileName);

      toast.success(
        grant
          ? `Export ready. File links expire ${format(new Date(grant.expiresAt), "yyyy MMM dd")}.`
          : "Export ready.",
      );
    } catch (error: any) {
      Logger.error({
        msg: filtered
          ? "Error exporting filtered patients:"
          : "Error exporting patients:",
        error,
      });
      toast.error(
        filtered
          ? "Failed to export filtered patients"
          : "Failed to export patients",
      );
    }
  };

  const openLinkManager = async () => {
    try {
      setLiveGrants(await listAttachmentExportGrants());
    } catch (error) {
      Logger.error({ msg: "Error loading export file links:", error });
      toast.error("Could not load export file links");
    }
  };

  const revokeGrant = async (grantId: string) => {
    try {
      await revokeAttachmentExportGrant({ data: { grantId } });
      setLiveGrants(await listAttachmentExportGrants());
      toast.success("File links revoked");
    } catch (error) {
      Logger.error({ msg: `Error revoking export grant ${grantId}:`, error });
      toast.error("Could not revoke these file links");
    }
  };

  const openPatientChart = (patientId: string) => {
    navigate({ to: `/app/patients/${patientId}` });
  };

  const handleCreateAppointment = (
    event: React.MouseEvent<HTMLButtonElement>,
    patientId: string,
  ) => {
    event.stopPropagation();
    event.preventDefault();
    navigate({ to: `/app/appointments/edit?patientId=${patientId}` });
  };

  const pageNumbers = getPageNumbers();

  if (!patientRegistrationForm) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] p-8">
        <div className="text-center space-y-4">
          <h2 className="text-2xl font-semibold text-gray-800">
            No Registration Form Available
          </h2>
          <p className="text-gray-600">
            Please create a patient registration form first.
          </p>
          <Link to="/app/patients/customize-registration-form" className="mt-4">
            <Button className="primary">Create Registration Form</Button>
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="w-full flex flex-col gap-3 py-4 max-w-2xl">
        <Input
          className="pl-4 pr-4 max-w-2xl"
          placeholder="Search patients..."
          label="Search Patients"
          type="search"
          value={searchState.searchQuery}
          onChange={(e) =>
            dispatchSearchAction({
              type: "update-search-query",
              payload: e.target.value,
            })
          }
        />

        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="gap-1 px-0 text-muted-foreground hover:text-foreground"
            >
              <LucideChevronDown className="h-4 w-4 transition-transform [[data-state=open]_&]:rotate-180" />
              Advanced filters
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent className="flex flex-col gap-3 pt-2">
            <div className="flex flex-col gap-1">
              <label className="text-sm font-medium">Primary Clinic</label>
              <Select
                isMulti
                placeholder="All clinics"
                options={clinics.map((c) => ({
                  value: c.id,
                  label: c.name ?? c.id,
                }))}
                value={searchState.clinicIds.map((id) => {
                  const clinic = clinics.find((c) => c.id === id);
                  return { value: id, label: clinic?.name ?? id };
                })}
                onChange={(selected) =>
                  dispatchSearchAction({
                    type: "update-clinic-ids",
                    payload: selected.map((s) => s.value),
                  })
                }
                classNamePrefix="react-select"
                className="max-w-md"
              />
            </div>

            <fieldset className="flex items-end gap-2">
              <legend className="text-sm font-medium mb-1">
                Patient was registered within this Date Range
              </legend>
              <DatePickerInput
                placeholder="From"
                value={searchState.registrationDate[0] ?? undefined}
                onChange={(date) =>
                  dispatchSearchAction({
                    type: "update-registration-date-start",
                    payload: date ?? null,
                  })
                }
                className="w-36"
              />
              <span className="pb-2 text-sm text-muted-foreground">
                &ndash;
              </span>
              <DatePickerInput
                placeholder="To"
                value={searchState.registrationDate[1] ?? undefined}
                onChange={(date) =>
                  dispatchSearchAction({
                    type: "update-registration-date-end",
                    payload: date ?? null,
                  })
                }
                className="w-36"
              />
            </fieldset>

            <fieldset className="flex items-end gap-2">
              <legend className="text-sm font-medium mb-1">
                Patient had a visit within this Date Range
              </legend>
              <DatePickerInput
                placeholder="From"
                value={searchState.visitsInDateRange[0] ?? undefined}
                onChange={(date) =>
                  dispatchSearchAction({
                    type: "update-visits-date-start",
                    payload: date ?? null,
                  })
                }
                className="w-36"
              />
              <span className="pb-2 text-sm text-muted-foreground">
                &ndash;
              </span>
              <DatePickerInput
                placeholder="To"
                value={searchState.visitsInDateRange[1] ?? undefined}
                onChange={(date) =>
                  dispatchSearchAction({
                    type: "update-visits-date-end",
                    payload: date ?? null,
                  })
                }
                className="w-36"
              />
            </fieldset>
          </CollapsibleContent>
        </Collapsible>

        <div className="flex items-center justify-end gap-3">
          <Button
            variant="ghost"
            onClick={() => {
              dispatchSearchAction({ type: "reset" });
              handleSearch(1);
            }}
            className="text-muted-foreground"
          >
            Clear filters
          </Button>

          <Button
            type="submit"
            onClick={() => handleSearch(1)}
            disabled={loading}
          >
            {loading ? "Searching..." : "Search"}
          </Button>
        </div>
      </div>

      <div className="pt-4 flex gap-3">
        <Button
          type="button"
          variant="outline"
          onClick={() => setPendingExport("all")}
        >
          <LucideDownload className="mr-2 h-4 w-4" />
          Export All Patient Data
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setPendingExport("filtered")}
          disabled={!hasActiveFilters || patientsList.length === 0}
        >
          <LucideFilter className="mr-2 h-4 w-4" />
          Export Filtered Patients ({totalItems})
        </Button>
        <Button type="button" variant="ghost" onClick={openLinkManager}>
          <LucideLink className="mr-2 h-4 w-4" />
          Manage export file links
        </Button>
      </div>

      <ExportFileLinksDialog
        grants={liveGrants}
        onClose={() => setLiveGrants(null)}
        onRevoke={revokeGrant}
      />

      <ExportOptionsDialog
        scope={pendingExport}
        options={exportOptions}
        onOptionsChange={setExportOptions}
        onCancel={() => setPendingExport(null)}
        onConfirm={(scope) => {
          setPendingExport(null);
          runExport(scope, exportOptions);
        }}
      />

      <If show={selectedPatients.size > 0}>
        <div className="mt-8 font-semibold">
          {selectedPatients.size} Patients Selected
        </div>
        <div className="space-x-4">
          <Button
            size={"default"}
            onClick={handleResetPatientSelection}
            variant="outline"
            className=""
          >
            <LucideBox className="mr-2 h-4 w-4" />
            Unselect all patients
          </Button>
          <Button
            size={"default"}
            variant="outline"
            onClick={handleDeleteSelectedPatients}
            className="text-red-800"
          >
            <LucideTrash className="mr-2 h-4 w-4 text-red-500" />
            Delete Selected Patients
          </Button>
        </div>
      </If>

      <div className="rounded-md border overflow-hidden  mt-8">
        <Table className="overflow-scroll">
          <TableHeader>
            <TableRow>
              <TableHead className="px-6" key={"actions"}>
                Actions
              </TableHead>
              <TableHead className="px-6" key={"id"}>
                ID
              </TableHead>
              {headers?.map((header) => (
                <TableHead className="px-6" key={header}>
                  {header}
                </TableHead>
              ))}
              <TableHead className="px-6" key={"created_at"}>
                Record Created At
              </TableHead>
              <TableHead className="px-6" key={"updated_at"}>
                Last Updated At
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {patientsList.length === 0 &&
              searchState.searchQuery.trim().length > 0 &&
              !loading && (
                <TableRow>
                  <TableCell
                    colSpan={headers.length + 2}
                    className="px-6 py-8 text-center text-gray-500"
                  >
                    No results found matching your search
                  </TableCell>
                </TableRow>
              )}
            {patientsList?.map((patient) => (
              <TableRow
                className="hover:bg-gray-100 cursor-pointer"
                onClick={() => openPatientChart(patient.id)}
                key={patient.id}
              >
                <TableCell
                  className="px-6 space-x-4"
                  onClick={(evt) => {
                    evt.stopPropagation();
                  }}
                  key={"actions"}
                >
                  <Checkbox
                    checked={selectedPatients.has(patient.id)}
                    onCheckedChange={() => {
                      handleToggleSelectedPatients(
                        patient.id,
                        patient.given_name,
                      );
                    }}
                  />
                  <Button
                    onClick={(evt) => handleCreateAppointment(evt, patient.id)}
                    variant="outline"
                  >
                    <LucideCalendarPlus />
                  </Button>
                </TableCell>
                <TableCell className="px-6" key={"id"}>
                  {truncate(patient.id, { length: 12, omission: "…" })}
                </TableCell>
                {fields?.map((field) =>
                  field.baseField ? (
                    <TableCell className="px-6" key={field.id}>
                      {PatientRegistrationForm.renderFieldValue(
                        field,
                        patient[field.column as keyof typeof patient],
                      )}
                    </TableCell>
                  ) : (
                    <TableCell className="px-6" key={field.id}>
                      {PatientRegistrationForm.renderFieldValue(
                        field,
                        patient.additional_attributes[field.id],
                      )}
                    </TableCell>
                  ),
                )}
                <TableCell className="px-6" key={"created_at"}>
                  {format(patient.created_at, "yyyy MMM dd")}
                </TableCell>
                <TableCell className="px-6" key={"updated_at"}>
                  {format(patient.created_at, "yyyy MMM dd")}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="py-8">
        <Pagination>
          <PaginationContent>
            <PaginationItem>
              <PaginationPrevious
                onClick={() => handlePageChange(currentPage - 1)}
                className={
                  currentPage <= 1
                    ? "pointer-events-none opacity-50"
                    : "cursor-pointer"
                }
              />
            </PaginationItem>

            {pageNumbers?.map((pageNumber, index) => {
              const shouldShowEllipsis =
                index > 0 && pageNumber > pageNumbers[index - 1] + 1;

              return (
                <React.Fragment key={`page-${pageNumber}`}>
                  {shouldShowEllipsis && (
                    <PaginationItem>
                      <PaginationEllipsis />
                    </PaginationItem>
                  )}
                  <PaginationItem>
                    <PaginationLink
                      onClick={() => handlePageChange(pageNumber)}
                      isActive={pageNumber === currentPage}
                      className="cursor-pointer"
                    >
                      {pageNumber}
                    </PaginationLink>
                  </PaginationItem>
                </React.Fragment>
              );
            })}

            <PaginationItem>
              <PaginationNext
                onClick={() => handlePageChange(currentPage + 1)}
                className={
                  currentPage >= totalPages
                    ? "pointer-events-none opacity-50"
                    : "cursor-pointer"
                }
              />
            </PaginationItem>
          </PaginationContent>
        </Pagination>
      </div>
    </div>
  );
}

/** Cuts off a workbook that reached the wrong hands before its links expire. */
function ExportFileLinksDialog({
  grants,
  onClose,
  onRevoke,
}: {
  grants: ExportAccessGrantSummary[] | null;
  onClose: () => void;
  onRevoke: (grantId: string) => void;
}) {
  return (
    <Dialog
      open={grants !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export file links</DialogTitle>
          <DialogDescription>
            Each export you download gets one set of file links. Revoking a set
            immediately breaks every link in that workbook.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 py-2">
          {grants?.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              No exports of yours have live file links.
            </p>
          ) : null}
          {grants?.map((grant) => (
            <div
              key={grant.id}
              className="flex items-center justify-between gap-4 border-b pb-2 text-sm"
            >
              <div>
                <div>
                  Exported {format(new Date(grant.createdAt), "yyyy MMM dd")}
                </div>
                <div className="text-muted-foreground text-xs">
                  Expires {format(new Date(grant.expiresAt), "yyyy MMM dd")}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="text-red-800"
                onClick={() => onRevoke(grant.id)}
              >
                Revoke
              </Button>
            </div>
          ))}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The expiry entered here is advisory; AccessGrant.mint is what enforces it. */
function ExportOptionsDialog({
  scope,
  options,
  onOptionsChange,
  onCancel,
  onConfirm,
}: {
  scope: ExportScope | null;
  options: ExportOptions;
  onOptionsChange: (options: ExportOptions) => void;
  onCancel: () => void;
  onConfirm: (scope: ExportScope) => void;
}) {
  const expiryDaysCeiling = expiryDaysMax(
    ACCESS_GRANT_SCOPES.EVENT_FORM_ATTACHMENTS_READ,
  );

  return (
    <Dialog
      open={scope !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Export options</DialogTitle>
          <DialogDescription>
            Uploaded files are exported as links. Anyone with the workbook can
            open those links until they expire.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4 py-2">
          <Input
            type="number"
            label="File links expire after (days)"
            description={`Between ${EXPIRY_DAYS_MIN} and ${expiryDaysCeiling} days.`}
            min={EXPIRY_DAYS_MIN}
            max={expiryDaysCeiling}
            // Renders NaN as empty so the field can be cleared and retyped.
            value={
              Number.isNaN(options.linkExpiryDays) ? "" : options.linkExpiryDays
            }
            onChange={(e) =>
              onOptionsChange({
                ...options,
                linkExpiryDays: e.target.valueAsNumber,
              })
            }
          />

          <label className="flex items-start gap-3 text-sm">
            <Checkbox
              className="mt-0.5"
              checked={options.includeDeletedForms}
              onCheckedChange={(checked) =>
                onOptionsChange({
                  ...options,
                  includeDeletedForms: checked === true,
                })
              }
            />
            <span>
              Export includes deleted forms that may have patient data
            </span>
          </label>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            disabled={scope === null}
            onClick={() => {
              if (scope !== null) onConfirm(scope);
            }}
          >
            <LucideDownload className="mr-2 h-4 w-4" />
            Export
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
