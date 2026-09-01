import { useState, useEffect } from "react"
import { catchError, of as of$ } from "@nozbe/watermelondb/utils/rx"

import database from "@/db"
import Appointment from "@/models/Appointment"
import Clinic from "@/models/Clinic"
import Patient from "@/models/Patient"
import { Logger } from "@hikmahealth/js-utils"

/**
 * Fetches an appointment from the database given its ID.
 * @param appointmentId The ID of the appointment to fetch.
 * @returns The appointment object.
 */
export const useAppointment = (appointmentId: string) => {
  const [appointment, setAppointment] = useState<Appointment.DBAppointment | null>(null)
  const [clinic, setClinic] = useState<Clinic.DBClinic | null>(null)
  const [patient, setPatient] = useState<Patient.DBPatient | null>(null)
  const [isLoadingAppointment, setIsLoadingAppointment] = useState(false)
  const [isLoadingPatient, setIsLoadingPatient] = useState(false)
  const [isLoadingClinic, setIsLoadingClinic] = useState(false)

  const resetPatient = () => {
    setPatient(null)
    setIsLoadingPatient(false)
  }

  const resetClinic = () => {
    setClinic(null)
    setIsLoadingClinic(false)
  }

  useEffect(() => {
    if (!appointmentId || appointmentId === "") {
      setAppointment(null)
      return
    }

    setIsLoadingAppointment(true)
    const subscription = database
      .get<Appointment.DBAppointment>("appointments")
      .findAndObserve(appointmentId)
      .pipe(
        // Absent on this device — deleted upstream or never synced; unpiped it crashes the app.
        catchError((error) => {
          Logger.error(error)
          return of$(null)
        }),
      )
      .subscribe((apt) => {
        if (!apt) {
          setAppointment(null)
          resetPatient()
          resetClinic()
          return
        }

        const { getPatient, getClinic } = apt
        setAppointment(apt)
        getPatient
          .then((res) => {
            setPatient(res?.[0] ?? null)
            setIsLoadingPatient(false)
          })
          .catch(resetPatient)
        getClinic
          .then((res) => {
            setClinic(res?.[0] ?? null)
            setIsLoadingClinic(false)
          })
          .catch(resetClinic)
      })
    setIsLoadingAppointment(false)

    return () => {
      subscription.unsubscribe()
      setAppointment(null)
      setIsLoadingAppointment(false)
    }
  }, [appointmentId])

  const isLoading = isLoadingAppointment || isLoadingPatient || isLoadingClinic

  return { appointment, isLoading, clinic, patient }
}
