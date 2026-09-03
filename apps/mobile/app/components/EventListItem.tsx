import { useState } from "react"
import {
  ActivityIndicator,
  Alert,
  Image,
  ImageStyle,
  Modal,
  Pressable,
  StyleProp,
  TextStyle,
  ViewStyle,
} from "react-native"
import * as FileSystem from "expo-file-system/legacy"
import * as Sharing from "expo-sharing"
import { withObservables } from "@nozbe/watermelondb/react"
import { upperFirst } from "es-toolkit/compat"
import { LucideEllipsisVertical, LucideEye, LucideFile } from "lucide-react-native"

import { Text } from "@/components/Text"
import { View } from "@/components/View"
import EventModel from "@/db/model/Event"
import Event from "@/models/Event"
import ICDEntry from "@/models/ICDEntry"
import Peer from "@/models/Peer"
import { colors } from "@/theme/colors"
import { getProviderAuthHeader, refreshProviderToken } from "@/utils/authHeader"
import { requestWithSessionRetry } from "@/utils/authorizedRequest"

import { If } from "./If"
import { displayDateValue } from "@/utils/date"
import { escapeHtml } from "@/utils/html"

type AttachmentKind = "image" | "pdf" | "file"

/** Mirrors the server's `@/lib/attachment-kind`; the two codebases cannot share a module. */
const attachmentKind = (mimetype: string | null | undefined): AttachmentKind => {
  if (!mimetype) return "file"
  if (mimetype === "application/pdf") return "pdf"
  if (mimetype.startsWith("image/")) return "image"
  return "file"
}

export interface EventListItemProps {
  /**
   * An optional style override useful for padding & margin.
   */
  style?: StyleProp<ViewStyle>

  event: EventModel
  openEventOptions: (event: EventModel) => void
  language: string
}

/** Props for the plain (non-WatermelonDB) variant */
export interface EventListItemPlainProps {
  style?: StyleProp<ViewStyle>
  event: { eventType: string; formData: Event.FormDataItem[]; createdAt: Date; id: string }
  openEventOptions: (event: any) => void
  language: string
}

const enhanceEvent = withObservables(["event"], ({ event }) => ({
  event, // shortcut syntax for `event: event.observe()`
}))

/**
 * Inner component rendering logic shared between enhanced and plain variants
 */
function EventListItemInner({
  style,
  event,
  language,
  openEventOptions,
}: {
  style?: StyleProp<ViewStyle>
  event: { eventType: string; formData: Event.FormDataItem[]; createdAt: Date; id: string }
  openEventOptions: (event: any) => void
  language: string
}) {
  const display = getEventDisplay(event as any, language)
  const time = new Date(event.createdAt).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  })

  const $styles = [$container, style]

  return (
    <View style={$styles}>
      <Pressable testID="eventListItem" style={{}} onLongPress={() => openEventOptions(event)}>
        <View style={{}}>
          <View m={10}>
            <View style={$eventTitleContainer}>
              <View direction="row" justifyContent="space-between" alignItems="center">
                <Text preset="subheading">{`${event.eventType}`}</Text>
                <Pressable onPress={() => openEventOptions(event)}>
                  <LucideEllipsisVertical size={20} color={colors.palette.primary400} />
                </Pressable>
              </View>
              <Text preset="formHelper">{`${time}`}</Text>
            </View>
            {display}
          </View>
        </View>
      </Pressable>
    </View>
  )
}

/**
 * Displays a single event (WatermelonDB-enhanced, observes the event model)
 */
export const EventListItem = enhanceEvent(function EventListItem(props: EventListItemProps) {
  return <EventListItemInner {...props} />
})

/**
 * Plain variant of EventListItem that works with Event.T (no WatermelonDB observables).
 * Use this in online mode where data comes from the server, not WatermelonDB.
 */
export function EventListItemPlain(props: EventListItemPlainProps) {
  return <EventListItemInner {...props} />
}

const $eventTitleContainer: ViewStyle = {
  flex: 1,
  borderBottomWidth: 1,
  borderBottomColor: colors.border,
  alignContent: "center",
}

// const sampleEventFormData = [
//   { fieldId: "0.7000418575055709", inputType: "select", name: "Smoking", value: "never" },
//   { fieldId: "0.0041672042847438195", inputType: "select", name: "Alcohol Use", value: "monthly" },
//   { fieldId: "0.00416720428474312195", inputType: "text", name: "Alcohol Use", value: "monthly" },
//   { fieldId: "0.10216220428474312195", inputType: "number", name: "Alcohol Use", value: "2" },
//   {
//     fieldId: "0.13706160353693075",
//     inputType: "textarea",
//     name: "Other Substance Use",
//     value: "Some other substances",
//   },
//   { fieldId: "0.5535755404453206", inputType: "select", name: "Education", value: "university" },
//   { fieldId: "0.1541258757669901", inputType: "select", name: "Income", value: "adequate" },
//   { fieldId: "0.23191226524160435", inputType: "select", name: "Housing", value: "temporary" },
//   { fieldId: "0.32407480221952545", inputType: "select", name: "Nutrition", value: "sufficient" },
// ]

/**
 * Given FormDataItem, return an array of only the diagnoses and their ICD10 codes
 * @param {FormDataItem[]} FormDataItem array- The FormDataItem object
 * @returns {Array<ICDEntry.T>} - An array of ICD10Entry objects
 */
export const getDiagnosesFromFormData = (formData: Event.FormDataItem[]): Array<ICDEntry.T> => {
  const diagnoses = formData.filter((field) => field.fieldType === "diagnosis")
  const diagnosesWithCodes = diagnoses.map((diagnosis) => {
    const { value } = diagnosis
    if (Array.isArray(value) && value.length > 0) {
      return value
    }
  })

  return diagnosesWithCodes.flat().filter((diagnosis) => diagnosis !== undefined)
}

/**
 * Get the display for the event, based on the event type, for the formatted dynamic fields of formData
 * @param {Event} event - The event object
 * @param {string} language - The language code
 * @returns {JSX.Element} - The JSX element to display
 */
const getEventDisplay = (event: EventModel, language: string): React.JSX.Element => {
  const { formData } = event

  return (
    <View>
      {formData.map((field, idx) => {
        const { fieldId, fieldType, inputType, name, value } = field
        // const displayValue = inputType === "select" ? translate(value, language) : value

        return (
          <View
            key={`${idx}-${fieldId}`}
            gap={inputType === "textarea" || inputType === "input-group" ? 1 : 10}
            direction={inputType === "textarea" || inputType === "input-group" ? "column" : "row"}
            my={5}
          >
            <Text preset="formLabel" textDecorationLine="underline" text={name + ":"} />

            <If condition={fieldType === "diagnosis"}>
              {Array.isArray(value) &&
                value?.map((val, idx) => (
                  <View key={`${idx}-diagnosis`}>
                    <Text text={ICDEntry.ICD10RecordLabel(val, language)} />
                  </View>
                ))}
            </If>
            <If condition={inputType === "input-group" && fieldType === "medicine"}>
              <View gap={5}>
                {Array.isArray(value) &&
                  value.map((med, idx) => (
                    <View
                      key={med.id}
                      style={idx + 1 < value.length ? $medicineItemSeparator : undefined}
                    >
                      <Text text={upperFirst(String(med.name || ""))} />
                      <Text text={`${String(med.dose || "")} ${med.doseUnits || ""}`} />
                      <Text
                        text={`${upperFirst(med?.route || "")} ${upperFirst(
                          med?.form || "",
                        )}: ${String(med?.frequency || "")}`}
                      />
                    </View>
                  ))}
              </View>
            </If>
            <If condition={inputType === "file"}>
              <View gap={5}>
                {Event.readAttachments(field).map((attachment) => (
                  <FileAttachmentField
                    key={attachment.id}
                    eventId={event.id}
                    resourceId={attachment.id}
                    fileName={attachment.fileName}
                    mimetype={attachment.mimetype}
                  />
                ))}
              </View>
            </If>
            <If
              condition={
                fieldType !== "diagnosis" && inputType !== "input-group" && inputType !== "file"
              }
            >
              {fieldType === "date" ? (
                <Text text={displayDateValue(value)} />
              ) : (
                <Text text={String(value)} />
              )}
            </If>
          </View>
        )
      })}
    </View>
  )
}

/**
 * A single event-form file attachment. Bytes are fetched on press, not on
 * render, and cached by resource id so two same-named files never collide.
 * Every view goes through the audited download route.
 */
function FileAttachmentField({
  eventId,
  resourceId,
  fileName,
  mimetype,
}: {
  eventId: string
  resourceId: string
  fileName: string | null
  mimetype: string | null
}): React.JSX.Element | null {
  const [isLoading, setIsLoading] = useState(false)
  const [imageUri, setImageUri] = useState<string | null>(null)

  const label = fileName ?? "Attachment"

  const openAttachment = async () => {
    if (isLoading || !resourceId) return
    setIsLoading(true)
    try {
      const authorization = await getProviderAuthHeader()
      if (!authorization) throw new Error("Not signed in. Please sign in again.")

      // Attachments are cloud-only; `getActiveUrl` would hand back the hub.
      const apiUrl = await Peer.getCloudApiUrl()
      if (!apiUrl) {
        throw new Error("Attachments need a cloud server, and none is configured on this device.")
      }

      const storedKind = attachmentKind(mimetype)
      const extension = storedKind === "pdf" ? ".pdf" : storedKind === "image" ? ".png" : ""
      const target = `${FileSystem.cacheDirectory}hh_attachment_${resourceId}${extension}`

      const url = `${apiUrl}/api/events/${eventId}/attachments/${resourceId}`
      const result = await requestWithSessionRetry({
        authorization,
        refresh: () => refreshProviderToken(apiUrl),
        attempt: (auth) =>
          FileSystem.downloadAsync(url, target, { headers: { Authorization: auth } }),
      })

      // A non-200 wrote a JSON error body to the file, not the attachment.
      if (result.status !== 200) {
        throw new Error(
          result.status === 401
            ? "Your session has expired. Please sign in again."
            : "This attachment could not be opened.",
        )
      }

      const kind = attachmentKind(mimetype ?? result.mimeType)
      if (kind === "image") {
        setImageUri(result.uri)
        return
      }

      const shareType = mimetype ?? result.mimeType ?? "application/pdf"
      if (!(await Sharing.isAvailableAsync())) {
        throw new Error("Opening files is not supported on this device.")
      }
      await Sharing.shareAsync(result.uri, {
        mimeType: shareType,
        UTI: shareType === "application/pdf" ? "com.adobe.pdf" : undefined,
      })
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Could not open attachment."
      Alert.alert("Attachment", message)
    } finally {
      setIsLoading(false)
    }
  }

  // An optional file field left empty carries no resource id.
  if (!resourceId) return null

  return (
    <View direction="row" alignItems="center" gap={8}>
      <LucideFile size={16} color={colors.palette.primary400} />
      <Text text={label} />
      <Pressable onPress={openAttachment} disabled={isLoading} hitSlop={8}>
        <View direction="row" alignItems="center" gap={4}>
          {isLoading ? (
            <ActivityIndicator size="small" color={colors.palette.primary400} />
          ) : (
            <LucideEye size={16} color={colors.palette.primary400} />
          )}
          <Text preset="formLabel" text="View attachment" style={$viewLink} />
        </View>
      </Pressable>

      <Modal
        visible={imageUri !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setImageUri(null)}
      >
        <Pressable style={$modalBackdrop} onPress={() => setImageUri(null)}>
          {imageUri !== null && (
            <Image source={{ uri: imageUri }} style={$modalImage} resizeMode="contain" />
          )}
        </Pressable>
      </Modal>
    </View>
  )
}

const $medicineItemSeparator: ViewStyle = {
  borderBottomWidth: 1,
  borderBottomColor: colors.border,
}

const $viewLink: TextStyle = {
  textDecorationLine: "underline",
  color: colors.palette.primary400,
}

const $modalBackdrop: ViewStyle = {
  flex: 1,
  backgroundColor: "rgba(0, 0, 0, 0.9)",
  justifyContent: "center",
  alignItems: "center",
  padding: 16,
}

const $modalImage: ImageStyle = {
  width: "100%",
  height: "100%",
}

/**
 * Get the display for the event, based on the event type, for the formatted dynamic fields of formData
 * THIS IS ONLY USED FOR PRINTING OUT A HTML BASED REPORT
 * @param {Event} event - The event object
 * @param {string} language - The language code
 * @returns {JSX.Element} - The JSX element to display
 */
export const getHtmlEventDisplay = (event: EventModel, language: string): string => {
  const { eventType, formData } = event

  let display = ""

  formData.forEach((field, idx) => {
    const { fieldId, fieldType, inputType, name, value } = field

    display += `<div style="margin: 5px 0px;">`
    display += `<span style="text-decoration: underline;">${escapeHtml(String(name))}:</span>`

    if (fieldType === "diagnosis") {
      if (Array.isArray(value)) {
        value?.forEach((val) => {
          display += `<div>${escapeHtml(ICDEntry.ICD10RecordLabel(val, language))}</div>`
        })
      }
    } else if (inputType === "input-group" && fieldType === "medicine") {
      if (Array.isArray(value)) {
        value.forEach((med) => {
          if (!med) return
          display += `<div>${escapeHtml(String(med.dose || ""))} ${escapeHtml(String(med.doseUnits || ""))}</div>`
          display += `<div>${escapeHtml(upperFirst(med?.route || ""))} ${escapeHtml(upperFirst(med?.form || ""))}: ${escapeHtml(
            String(med?.frequency || ""),
          )}</div>`
        })
      }
    } else if (fieldType !== "diagnosis" && inputType !== "input-group") {
      const text = fieldType === "date" ? displayDateValue(value) : String(value)
      display += `<div>${escapeHtml(text)}</div>`
    }

    display += `</div>`
  })

  return display
}

const $container: ViewStyle = {
  paddingVertical: 8,
}
