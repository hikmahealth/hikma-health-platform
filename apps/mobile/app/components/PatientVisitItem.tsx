import { FC } from "react"
import { Pressable, StyleProp, TextStyle, ViewStyle } from "react-native"
import { withObservables } from "@nozbe/watermelondb/react"
import { format, isValid } from "date-fns"
import { LucideTrash2 } from "lucide-react-native"
import { catchError, of as of$ } from "rxjs"

import { Text } from "@/components/Text"
import { translate } from "@/i18n/translate"
import { colors } from "@/theme/colors"
import { useAppTheme } from "@/theme/context"
import type { ThemedStyle } from "@/theme/types"

import { If } from "./If"
import { View } from "./View"

export interface PatientVisitItemProps {
  /**
   * An optional style override useful for padding & margin.
   */
  style?: StyleProp<ViewStyle>

  /**
   * The visit object to display
   */
  visit: any

  /**
   * The clinic associated with the visit
   */
  clinic?: any

  /**
   * The provider who recorded the visit. Absent in online mode.
   */
  provider?: any

  /**
   * Callback function when the visit item is pressed
   */
  onPress: (visit: any) => void

  /**
   * Callback function when the delete action is triggered
   */
  onDelete: (visitId: string) => void
}

// `visit.clinic` is an immutableRelation, so its observable is a bare
// findAndObserve(clinic_id) with no null guard: both an absent clinic_id and one
// pointing at a clinic this device never synced make it error, and
// withObservables re-throws that during render — taking down the whole screen
// rather than one row. Test the foreign key, then catch the dangling-id case.
const enhanceVisitItem = withObservables(["visit"], ({ visit }) => ({
  visit, // shortcut for visit.observe
  clinic: visit.clinicId
    ? visit.clinic.observe().pipe(catchError(() => of$(null)))
    : of$(null),
  // Not a relation on Visit, so look it up through the record's own database
  // rather than the imported singleton. Same dangling-id hazard as the clinic.
  provider: visit.providerId
    ? visit.collections
        .get("users")
        .findAndObserve(visit.providerId)
        .pipe(catchError(() => of$(null)))
    : of$(null),
}))

/** The live users-table name wins; the copy on the visit is the fallback. */
export const resolveProviderName = (
  liveName: string | null | undefined,
  storedName: string | null | undefined,
): string => liveName?.trim() || storedName || ""

/** Inner rendering logic shared by both enhanced and plain variants */
function PatientVisitItemInner({
  visit,
  clinic,
  provider,
  onPress,
  onDelete,
}: PatientVisitItemProps) {
  const providerName = resolveProviderName(provider?.name, visit.providerName)

  return (
    <Pressable
      style={{ marginBottom: 32 }}
      testID="visitItem"
      onPress={() => onPress(visit)}
      onLongPress={() => onDelete(visit.id)}
    >
      <View style={{}}>
        <View direction="row" gap={10} justifyContent="space-between" alignItems="center">
          <Text style={{ fontSize: 18 }} text={format(visit.checkInTimestamp, "dd MMM yyyy")} />

          <Pressable onPress={() => onDelete(visit.id)}>
            <LucideTrash2 size={18} color={colors.palette.angry400} />
          </Pressable>
        </View>
        <View
          style={{
            marginVertical: 5,
            borderBottomColor: "#ccc",
            borderBottomWidth: 1,
          }}
        />
        {/* `If` is a component, so this child is built before the condition is
            read — the access must be safe on its own. */}
        <If condition={!!clinic}>
          <Text>
            {translate("common:clinic")}: {clinic?.name}
          </Text>
        </If>
        <If condition={visit.checkInTimestamp && isValid(visit.checkInTimestamp)}>
          <Text>
            {translate("common:checkedIn")}: {format(visit.checkInTimestamp, "HH:mm a")}
          </Text>
        </If>
        <Text>
          {translate("common:provider")}: {providerName}
        </Text>
      </View>
    </Pressable>
  )
}

export const PatientVisitItem: FC<PatientVisitItemProps> = enhanceVisitItem(
  (props: PatientVisitItemProps) => <PatientVisitItemInner {...props} />,
)

/**
 * Plain variant of PatientVisitItem that works with Visit.T (no WatermelonDB observables).
 * In online mode, `clinic` will be undefined — the If guard handles this gracefully.
 */
export function PatientVisitItemPlain(props: PatientVisitItemProps) {
  return <PatientVisitItemInner {...props} />
}

const $container: ViewStyle = {
  justifyContent: "center",
}

const $text: ThemedStyle<TextStyle> = ({ colors, typography }) => ({
  fontFamily: typography.primary.normal,
  fontSize: 14,
  color: colors.palette.primary500,
})
