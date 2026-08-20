import { useEffect, useMemo, useState } from "react"
import { isValid, startOfDay } from "date-fns"
import { useDebounceValue } from "usehooks-ts"

import database from "@/db"
import PrescriptionModel from "@/db/model/Prescription"
import { useFollowCurrentDay } from "@/hooks/useFollowCurrentDay"
import Clinic from "@/models/Clinic"
import Prescription from "@/models/Prescription"
import { Logger } from "@hikmahealth/js-utils"

type ISOStringDate = string

export type PrescriptionsFilters = {
  status: Prescription.Status[]
  date: Date
  clinicId: string
  country: string
  city: string
  searchQuery: string
}

const initialFilters: PrescriptionsFilters = {
  status: ["pending"],
  date: startOfDay(new Date()),
  clinicId: "",
  country: "",
  city: "",
  searchQuery: "",
}

/** How many more patient groups each `loadMore` reveals. */
const GROUP_PAGE_SIZE = 20

/**
 * Upper bound on the prescriptions read for one day.
 *
 * The per-patient counts must describe the whole day, so the query cannot be
 * paged by row. `isTruncated` reports when this ceiling bites.
 */
const DAY_ROW_CEILING = 2000

export function useDBPrescriptionsFilter(
  clinicId: string,
  clinics: readonly Clinic.LocationFields[],
  date?: ISOStringDate,
): {
  filters: PrescriptionsFilters
  handleFiltersChange: (newFilters: Partial<PrescriptionsFilters>) => void
  clearFilters: () => void
  /** Patient groups revealed so far, each carrying that patient's full day. */
  groups: Prescription.PatientGroup[]
  /** True when the day held more prescriptions than `DAY_ROW_CEILING`. */
  isTruncated: boolean
  loadMore: () => Promise<void>
  isLoading: boolean
} {
  const [filters, setFilters] = useState<PrescriptionsFilters>({
    ...initialFilters,
    clinicId,
    date: date && isValid(new Date(date)) ? startOfDay(new Date(date)) : startOfDay(new Date()),
  })

  const [visibleGroupCount, setVisibleGroupCount] = useState(GROUP_PAGE_SIZE)

  const [loading, setLoading] = useState(true)
  const [dayGroups, setDayGroups] = useState<Prescription.PatientGroup[]>([])
  const [isTruncated, setIsTruncated] = useState(false)
  const [debouncedSearchQuery, setDebouncedSearchQuery] = useDebounceValue(filters.searchQuery, 500)

  useEffect(() => {
    setDebouncedSearchQuery(filters.searchQuery)
  }, [filters.searchQuery, setDebouncedSearchQuery])

  // Extract date string for dependency array
  const dateString = filters.date.toISOString()

  const clinicIds = useMemo(
    () =>
      Clinic.resolveClinicIdConstraint(clinics, {
        country: filters.country,
        city: filters.city,
        clinicId: filters.clinicId,
      }),
    [clinics, filters.country, filters.city, filters.clinicId],
  )
  // A comparable stand-in for the clinic, country and city filters together.
  // "all" rather than "" so an unset selection stays distinct from one that
  // matches no clinic.
  const clinicIdsKey = clinicIds === null ? "all" : clinicIds.join(",")

  useEffect(() => {
    Logger.log("useDBPrescriptionsFilter useEffect called")
    const { status, date } = filters
    setLoading(true)

    // Prepare status filter - handle empty array case for "all"
    const statusFilter = status.length === 0 ? [] : status

    // Build the conditions using the helper function
    const conditions = Prescription.DB.createSearchQueryConditions(
      debouncedSearchQuery,
      clinicIds,
      statusFilter,
      date,
      { offset: 0, limit: DAY_ROW_CEILING },
    )

    // `observe()` alone misses a status change that keeps the row in the set,
    // leaving the breakdown claiming a status the row no longer has.
    const sub = database
      .get<PrescriptionModel>("prescriptions")
      .query(...conditions)
      .observeWithColumns(["status"])
      .subscribe((prescriptions) => {
        const results = prescriptions.map(Prescription.DB.rawToT)
        setDayGroups(Prescription.groupByPatient(results))
        setIsTruncated(results.length >= DAY_ROW_CEILING)
        setLoading(false)
      })

    return () => {
      sub.unsubscribe()
    }
  }, [clinicIdsKey, filters.status, dateString, debouncedSearchQuery])

  const handleFiltersChange = (newFilters: Partial<PrescriptionsFilters>) => {
    setVisibleGroupCount(GROUP_PAGE_SIZE)

    // Prune only on a location change. On every change it would clear a clinic
    // the user never chose to clear: the provider's own clinic is absent from
    // `clinics` while archived or still syncing, so pruning would drop it,
    // leaving no constraint at all and widening the list to every clinic.
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

  useFollowCurrentDay(filters.date, (today) => handleFiltersChange({ date: today }))

  const clearFilters = () => {
    setVisibleGroupCount(GROUP_PAGE_SIZE)
    setFilters({
      ...initialFilters,
      clinicId,
      date: startOfDay(new Date()),
    })
  }

  /** Infinite scroll: the day is already in memory, so this widens the slice. */
  const loadMore = async () => {
    if (visibleGroupCount >= dayGroups.length) {
      Logger.log("Reached end of prescription data")
      return
    }

    setVisibleGroupCount((previous) => previous + GROUP_PAGE_SIZE)
  }

  const groups = useMemo(
    () => dayGroups.slice(0, visibleGroupCount),
    [dayGroups, visibleGroupCount],
  )

  return {
    filters,
    handleFiltersChange,
    clearFilters,
    groups,
    isTruncated,
    isLoading: loading,
    loadMore,
  }
}
