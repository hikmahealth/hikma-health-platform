import { useEffect, useMemo, useState } from "react"
import { isValid, startOfDay } from "date-fns"
import { useDebounceValue } from "usehooks-ts"

import database from "@/db"
import Appointment from "@/models/Appointment"
import Clinic from "@/models/Clinic"

export type AppointmentsFilters = {
  status: Appointment.Status | "all"
  date: Date
  clinicId: string
  country: string
  city: string
  searchQuery: string
  departmentIds: string[]
}

const initialFilters: AppointmentsFilters = {
  status: "pending",
  date: startOfDay(new Date()),
  clinicId: "",
  country: "",
  city: "",
  searchQuery: "",
  departmentIds: [],
}

const PAGE_SIZE = 150

/**
 * The department filter can't be expressed as a query condition, so both the list and the
 * counter narrow their results with this. Shared so the two can't drift apart.
 */
const inSelectedDepartments = (
  appointment: { departments: readonly { id: string }[] },
  departmentIds: string[],
): boolean =>
  departmentIds.length === 0 ||
  appointment.departments.some((department) => departmentIds.includes(department.id))

type ISOStringDate = string

export function useDBAppointmentsFilter(
  clinicId: string,
  clinics: readonly Clinic.LocationFields[],
  date?: ISOStringDate,
): {
  filters: AppointmentsFilters
  handleFiltersChange: (newFilters: Partial<AppointmentsFilters>) => void
  clearFilters: () => void
  appointments: Appointment.T[]
  /** `null` until the first count for the current filters has been read. */
  summary: Appointment.StatusSummary | null
  loadMore: () => Promise<void>
  isLoading: boolean
} {
  const [filters, setFilters] = useState<AppointmentsFilters>({
    ...initialFilters,
    clinicId,
    date: date && isValid(date) ? startOfDay(new Date(date)) : startOfDay(new Date()),
  })
  const [pagination, setPagination] = useState({
    offset: 0,
    limit: PAGE_SIZE,
  })
  const [loading, setLoading] = useState(true)
  const [appointmentResults, setAppointmentResults] = useState<Appointment.T[]>([])
  const [summary, setSummary] = useState<Appointment.StatusSummary | null>(null)
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useDebounceValue(filters.searchQuery, 500)
  useEffect(() => {
    setDebouncedSearchQuery(filters.searchQuery)
  }, [filters.searchQuery])

  const clinicIds = useMemo(
    () =>
      Clinic.resolveClinicIds(clinics, {
        country: filters.country,
        city: filters.city,
        clinicId: filters.clinicId,
      }),
    [clinics, filters.country, filters.city, filters.clinicId],
  )
  // A value the dependency array can compare; stands in for the clinic,
  // country and city filters together.
  const clinicIdsKey = clinicIds.join(",")

  useEffect(() => {
    const { status, date, searchQuery, departmentIds } = filters
    setLoading(true)

    // "all" is the no-status-filter sentinel; passing it through would become
    // Q.oneOf(["all"]) and match nothing.
    const statusFilter = status === "all" ? [] : [status]

    const conditions = Appointment.DB.createSearchQueryConditions(
      searchQuery,
      clinicIds,
      statusFilter,
      date,
      pagination,
    )

    const sub = database
      .get<Appointment.DBAppointment>("appointments")
      .query(...conditions)
      .observe()
      .subscribe((appointments) => {
        const results = appointments
          .map(Appointment.DB.rawToT)
          .filter((appointment) => inSelectedDepartments(appointment, departmentIds))
        setAppointmentResults(results)
        setLoading(false)
      })

    return () => {
      sub.unsubscribe()
    }
  }, [
    clinicIdsKey,
    filters.date.toISOString(),
    debouncedSearchQuery,
    filters.departmentIds,
    filters.status,
    pagination.limit,
  ])

  useEffect(() => {
    const { date, searchQuery, departmentIds } = filters
    // Clear rather than keep the last counts: stale numbers under new filters read as real,
    // where an absent line reads as "still counting".
    setSummary(null)

    // The summary reports one count per status, so it drops the status filter — otherwise
    // every bucket but the selected one would always read zero. It is unpaginated too: it
    // describes the whole day, not the page the list has scrolled to so far.
    const conditions = Appointment.DB.createSearchQueryConditions(
      searchQuery,
      clinicIds,
      [],
      date,
      { offset: 0, limit: 0 },
    )

    const sub = database
      .get<Appointment.DBAppointment>("appointments")
      .query(...conditions)
      .observe()
      .subscribe((appointments) => {
        const statuses = appointments
          .filter((appointment) => inSelectedDepartments(appointment, departmentIds))
          .map((appointment) => appointment.status)
        setSummary(Appointment.summarizeStatuses(statuses))
      })

    return () => {
      sub.unsubscribe()
    }
  }, [clinicIdsKey, filters.date.toISOString(), debouncedSearchQuery, filters.departmentIds])

  const handleFiltersChange = (newFilters: Partial<AppointmentsFilters>) => {
    // Prune only on a location change. On every change it would clear a clinic
    // the user never chose to clear: the provider's own clinic is absent from
    // `clinics` while archived or still syncing, so pruning would drop it and
    // widen the list from one clinic to every clinic.
    const touchesLocation =
      newFilters.country !== undefined ||
      newFilters.city !== undefined ||
      newFilters.clinicId !== undefined

    setFilters((prev) => {
      const next = { ...prev, ...newFilters }
      if (!touchesLocation) return next

      const location = Clinic.pruneLocationSelection(clinics, {
        country: next.country,
        city: next.city,
        clinicId: next.clinicId,
      })
      return { ...next, ...location }
    })
  }

  const clearFilters = () => {
    setFilters({ ...initialFilters, clinicId, date: startOfDay(new Date()) })
  }

  /**
   * This handles infinite scroll like, so we just increase the limit and re-run
   */
  const loadMore = async () => {
    // Check if we've received fewer results than requested
    // This indicates we've reached the end of available data
    if (appointmentResults.length < pagination.limit) {
      return
    }
    const nextPageLimit = pagination.limit + PAGE_SIZE
    setPagination((prev) => ({ ...prev, limit: nextPageLimit }))
  }

  return {
    filters,
    handleFiltersChange,
    clearFilters,
    appointments: appointmentResults,
    summary,
    isLoading: loading,
    loadMore,
  }
}
