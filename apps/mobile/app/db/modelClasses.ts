/**
 * Every model class the database is constructed with.
 *
 * Extracted so the test harness builds its databases from the same list the app
 * does. A class present in one list and absent from the other gives a passing
 * test suite against a schema the app never runs.
 */

import AppConfig from "./model/AppConfig"
import Appointment from "./model/Appointment"
import Clinic from "./model/Clinic"
import ClinicDepartment from "./model/ClinicDepartment"
import ClinicInventory from "./model/ClinicInventory"
import DispensingRecord from "./model/DispensingRecord"
import DrugCatalogue from "./model/DrugCatalogue"
import Event from "./model/Event"
import EventForm from "./model/EventForm"
import EventLog from "./model/EventLog"
import Patient from "./model/Patient"
import PatientAdditionalAttribute from "./model/PatientAdditionalAttribute"
import PatientProblems from "./model/PatientProblems"
import PatientRegistrationForm from "./model/PatientRegistrationForm"
import PatientRiskProfile from "./model/PatientRiskProfile"
import PatientVitals from "./model/PatientVitals"
import Peer from "./model/Peer"
import Prescription from "./model/Prescription"
import PrescriptionItem from "./model/PrescriptionItem"
import User from "./model/User"
import UserClinicPermissions from "./model/UserClinicPermissions"
import Visit from "./model/Visit"

export const modelClasses = [
  PatientRiskProfile,
  PatientRegistrationForm,
  Patient,
  Visit,
  Event,
  EventForm,
  User,
  Clinic,

  // v2
  PatientAdditionalAttribute,

  // v3
  Appointment,

  // v4
  Prescription,

  // v5
  AppConfig,
  PatientVitals,
  PatientProblems,
  UserClinicPermissions,

  // v6
  ClinicDepartment,

  // V7
  DrugCatalogue,
  ClinicInventory,
  PrescriptionItem,
  DispensingRecord,

  // V9
  EventLog,
  Peer,
]
