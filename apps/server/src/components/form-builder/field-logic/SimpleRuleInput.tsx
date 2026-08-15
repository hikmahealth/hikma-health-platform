import { LucidePlus, LucideX } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  COMPARISON_OP_LABELS,
  COMPARISON_OPS,
  type ComparisonOp,
  type Connector,
  type LogicField,
  type LogicOption,
  type SimpleVisibilityTemplate,
  type VisibilityCondition,
} from "@/lib/form-rule-templates";
import {
  type ConditionKind,
  conditionKindsFor,
  conditionsOf,
  defaultConditionFor,
  defaultConditionForKind,
  displayKindOf,
  isScalarOptionField,
  primitiveFieldsOf,
  templateFromConditions,
  unknownOptionTokens,
  type VisibilityKind,
} from "./rule-model";

// SimpleRuleInput — template-driven editor. Fully controlled: the owner
// holds the template and receives every change; no Save button here.

export type SimpleRuleInputProps = {
  referenceableFields: ReadonlyArray<LogicField>;
  template: SimpleVisibilityTemplate;
  onTemplateChange: (t: SimpleVisibilityTemplate) => void;
  allowAlways: boolean;
  allowMultiple: boolean;
  kindLabels: Record<VisibilityKind, string>;
};

export function SimpleRuleInput({
  referenceableFields,
  template,
  onTemplateChange,
  allowAlways,
  allowMultiple,
  kindLabels,
}: SimpleRuleInputProps) {
  const primitiveFields = primitiveFieldsOf(referenceableFields);

  const conditions = conditionsOf(template);
  const connector: Connector =
    template === "Always" ? "and" : template.connector;

  const emit = (next: VisibilityCondition[]) =>
    onTemplateChange(templateFromConditions(next, connector, allowAlways));

  const setConnector = (next: Connector) =>
    onTemplateChange(templateFromConditions(conditions, next, allowAlways));

  // Single-condition surfaces render a row synthesised by
  // `defaultConditionFor` when the list is empty (see below), so the first
  // edit to that row targets an index the list doesn't have yet. Append
  // rather than map, otherwise `[].map` silently discards the edit.
  const updateCondition = (index: number, c: VisibilityCondition) =>
    emit(
      index >= conditions.length
        ? [...conditions, c]
        : conditions.map((existing, i) => (i === index ? c : existing)),
    );

  // Single-condition surfaces (validators) render exactly one row with no
  // add/remove affordances. The condition always exists via defaultTemplateFor.
  if (!allowMultiple) {
    const only = conditions[0] ?? defaultConditionFor(primitiveFields);
    return (
      <ConditionRow
        primitiveFields={primitiveFields}
        condition={only}
        kindLabels={kindLabels}
        onChange={(c) => updateCondition(0, c)}
      />
    );
  }

  const addCondition = () =>
    emit([...conditions, defaultConditionFor(primitiveFields)]);
  const removeCondition = (index: number) =>
    emit(conditions.filter((_, i) => i !== index));

  return (
    <div className="space-y-3" data-testid="condition-list">
      {conditions.length === 0 && (
        <p className="text-xs text-muted-foreground italic">
          {kindLabels.Always}. Add a condition to restrict when this applies.
        </p>
      )}

      {/* One condition reads the same either way. */}
      {conditions.length > 1 && (
        <div className="space-y-1.5">
          <Label className="text-xs">Match</Label>
          <Select
            value={connector}
            onValueChange={(v) => setConnector(v as Connector)}
          >
            <SelectTrigger size="sm" data-testid="rule-connector">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="and">all of these conditions</SelectItem>
              <SelectItem value="or">any of these conditions</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      {conditions.map((c, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: ConditionRow is fully controlled by the template (no internal state), so a positional key stays correct across add/remove.
        <div key={i} className="space-y-2">
          {i > 0 && (
            <p
              className="text-[0.7rem] font-semibold uppercase tracking-wide text-muted-foreground"
              data-testid={`condition-separator-${i}`}
            >
              {connector}
            </p>
          )}
          <div
            className="flex items-start justify-between gap-2 rounded-md border border-border bg-card p-3"
            data-testid={`condition-row-${i}`}
          >
            <div className="flex-1">
              <ConditionRow
                primitiveFields={primitiveFields}
                condition={c}
                kindLabels={kindLabels}
                onChange={(next) => updateCondition(i, next)}
              />
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => removeCondition(i)}
              aria-label="Remove condition"
              data-testid="condition-remove"
            >
              <LucideX size="0.875rem" />
            </Button>
          </div>
        </div>
      ))}

      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={addCondition}
        data-testid="rule-add-condition"
      >
        <LucidePlus size="0.875rem" />
        Add condition
      </Button>
    </div>
  );
}

// The option token a single-pick row shows, across both the membership leaf and
// the equality leaf a scalar option field compiles to.
const optionValueOf = (condition: VisibilityCondition): string => {
  if (
    condition.TAG === "IncludesOption" ||
    condition.TAG === "ExcludesOption"
  ) {
    return condition.value;
  }
  if (condition.TAG === "Comparison" && typeof condition.value === "string") {
    return condition.value;
  }
  return "";
};

const optionValuesOf = (
  condition: VisibilityCondition,
): ReadonlyArray<string> =>
  condition.TAG === "IncludesAny" ||
  condition.TAG === "IncludesAll" ||
  condition.TAG === "EqualsAny"
    ? condition.values
    : [];

// One leaf condition: field picker + kind dropdown + (for comparisons) the
// operator/value inputs. Shared by the single-condition (validator) layout
// and each row of the multi-condition list.
function ConditionRow({
  primitiveFields,
  condition,
  kindLabels,
  onChange,
}: {
  primitiveFields: ReadonlyArray<LogicField>;
  condition: VisibilityCondition;
  kindLabels: Record<VisibilityKind, string>;
  onChange: (c: VisibilityCondition) => void;
}) {
  const field = primitiveFields.find((f) => f.id === condition.fieldId);
  const kind = displayKindOf(condition, field);
  const kinds = conditionKindsFor(field, condition);

  const onKindChange = (nextKind: ConditionKind) => {
    // The model fills kind-specific defaults (comparison operator, first
    // option, etc.); the field id is preserved via `field`.
    onChange(defaultConditionForKind(nextKind, field));
  };

  // Changing the field can invalidate the current kind (scalar ⇄ multi) or
  // strand an option token from the old field. Keep the kind when the new
  // field still supports it; reset value inputs either way.
  const onFieldChange = (newFieldId: string) => {
    const newField = primitiveFields.find((f) => f.id === newFieldId);
    const nextKinds = conditionKindsFor(newField);
    if (!nextKinds.includes(kind)) {
      onChange(defaultConditionForKind(nextKinds[0], newField));
      return;
    }
    // The same display kind compiles differently per arity, so option-backed
    // kinds are rebuilt from the new field's options.
    if (isScalarOptionField(newField) || newField?.multiValue) {
      onChange(defaultConditionForKind(kind, newField));
      return;
    }
    if (condition.TAG === "Comparison" || condition.TAG === "LengthCompare") {
      onChange({ ...condition, fieldId: newFieldId });
      return;
    }
    if (condition.TAG === "Truthy" || condition.TAG === "Falsy") {
      onChange({ TAG: condition.TAG, fieldId: newFieldId });
      return;
    }
    // Membership kinds carry field-specific option tokens — reset them.
    onChange(defaultConditionForKind(kind, newField));
  };

  // Both pickers serve membership leaves and the equality leaves a scalar option
  // field compiles to, so they write through these rather than one leaf shape.
  const setOptionValue = (value: string) => {
    if (condition.TAG === "Comparison") onChange({ ...condition, value });
    else if (condition.TAG === "IncludesOption")
      onChange({ ...condition, value });
    else if (condition.TAG === "ExcludesOption")
      onChange({ ...condition, value });
  };

  const setOptionValues = (values: string[]) => {
    if (condition.TAG === "IncludesAny") onChange({ ...condition, values });
    else if (condition.TAG === "IncludesAll")
      onChange({ ...condition, values });
    else if (condition.TAG === "EqualsAny") onChange({ ...condition, values });
  };

  return (
    <div className="space-y-3">
      {/* Field first: the kind list below depends on which field is picked, so
          the reverse order hides the membership kinds behind an unmade choice. */}
      <FieldPickerRow
        fields={primitiveFields}
        fieldId={condition.fieldId}
        onChange={onFieldChange}
      />

      <div className="space-y-1.5">
        <Label className="text-xs">When</Label>
        <Select
          value={kind}
          onValueChange={(v) => onKindChange(v as ConditionKind)}
        >
          <SelectTrigger size="sm" data-testid="rule-when-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {kinds.map((k) => (
              <SelectItem key={k} value={k}>
                {kindLabels[k]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* On an option field `==`/`!=` present as includes/excludes below, so the
          operator picker and raw value box are left to free-form fields — and to
          a legacy `>`-style rule on an option field. */}
      {kind === "Comparison" && condition.TAG === "Comparison" && (
        <ComparisonInputs
          op={condition.op}
          value={condition.value as string | number | boolean | null}
          primitiveKind={field?.primitiveKind}
          onOpChange={(op) => onChange({ ...condition, op })}
          onValueChange={(value) => onChange({ ...condition, value })}
        />
      )}

      {condition.TAG === "LengthCompare" && (
        <LengthCompareInputs
          op={condition.op}
          value={condition.value}
          onOpChange={(op) => onChange({ ...condition, op })}
          onValueChange={(value) => onChange({ ...condition, value })}
        />
      )}

      {(kind === "IncludesOption" || kind === "ExcludesOption") && (
        <OptionSelect
          options={field?.options ?? []}
          value={optionValueOf(condition)}
          onChange={setOptionValue}
        />
      )}

      {(kind === "IncludesAny" || kind === "IncludesAll") && (
        <MultiOptionSelect
          options={field?.options ?? []}
          values={optionValuesOf(condition)}
          onChange={setOptionValues}
        />
      )}
    </div>
  );
}

function OptionSelect({
  options,
  value,
  onChange,
}: {
  options: ReadonlyArray<LogicOption>;
  value: string;
  onChange: (v: string) => void;
}) {
  if (options.length === 0) {
    // `unknownOptionTokens` stays silent here on purpose, but the widget knows
    // more: a token against zero options is stranded, not merely unloaded.
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          This field has no options to choose from.
        </p>
        {value !== "" && <StaleOptionWarning tokens={[value]} />}
      </div>
    );
  }
  // With no item matching the stored token the trigger falls back to the
  // placeholder, so a stale rule reads as "nothing picked".
  const [stale] = unknownOptionTokens([value], options);
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Option</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger size="sm" data-testid="rule-option">
          <SelectValue placeholder="Pick an option" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
          {stale !== undefined && (
            <SelectItem value={stale}>{stale} — no longer an option</SelectItem>
          )}
        </SelectContent>
      </Select>
      {stale !== undefined && <StaleOptionWarning tokens={[stale]} />}
    </div>
  );
}

// Shown when a rule names an option that has since been renamed or removed. The
// rule still saves and compiles, so this prompts a re-pick rather than blocking.
function StaleOptionWarning({ tokens }: { tokens: ReadonlyArray<string> }) {
  return (
    <p
      className="text-[0.7rem] text-destructive"
      data-testid="rule-option-stale"
    >
      {tokens.length === 1
        ? `"${tokens[0]}" is no longer an option on this field, so this rule can never match.`
        : `${tokens.map((t) => `"${t}"`).join(", ")} are no longer options on this field, so this rule can never match.`}{" "}
      Pick a current option, or remove the condition.
    </p>
  );
}

function MultiOptionSelect({
  options,
  values,
  onChange,
}: {
  options: ReadonlyArray<LogicOption>;
  values: ReadonlyArray<string>;
  onChange: (values: string[]) => void;
}) {
  if (options.length === 0) {
    // As in OptionSelect: stranded tokens would otherwise be invisible behind
    // this placeholder.
    return (
      <div className="space-y-1.5">
        <p className="text-xs text-muted-foreground">
          This field has no options to choose from.
        </p>
        {values.length > 0 && <StaleOptionWarning tokens={values} />}
      </div>
    );
  }
  const toggle = (v: string) =>
    onChange(
      values.includes(v) ? values.filter((x) => x !== v) : [...values, v],
    );
  // A stale token matches no option row, so it gets its own checked row —
  // unchecking is how the author drops it.
  const stale = unknownOptionTokens(values, options);
  return (
    <div className="space-y-1.5" data-testid="rule-options">
      <Label className="text-xs">Options</Label>
      <div className="space-y-1.5">
        {options.map((o) => (
          <Checkbox
            key={o.value}
            size="sm"
            label={o.label}
            checked={values.includes(o.value)}
            onCheckedChange={() => toggle(o.value)}
            data-testid={`rule-option-${o.value}`}
          />
        ))}
        {stale.map((t) => (
          <Checkbox
            key={t}
            size="sm"
            label={`${t} — no longer an option`}
            checked
            onCheckedChange={() => toggle(t)}
            data-testid={`rule-option-${t}`}
          />
        ))}
      </div>
      {stale.length > 0 && <StaleOptionWarning tokens={stale} />}
      <p className="text-[0.7rem] text-muted-foreground">Pick at least two.</p>
    </div>
  );
}

function FieldPickerRow({
  fields,
  fieldId,
  onChange,
}: {
  fields: ReadonlyArray<LogicField>;
  fieldId: string;
  onChange: (id: string) => void;
}) {
  if (fields.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">
        No input fields available to reference yet.
      </p>
    );
  }
  return (
    <div className="space-y-1.5">
      <Label className="text-xs">Field</Label>
      <Select value={fieldId} onValueChange={onChange}>
        <SelectTrigger size="sm" data-testid="rule-field-picker">
          <SelectValue placeholder="Pick a field" />
        </SelectTrigger>
        <SelectContent>
          {fields.map((f) => (
            <SelectItem key={f.id} value={f.id}>
              {f.displayName}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ComparisonInputs({
  op,
  value,
  primitiveKind,
  onOpChange,
  onValueChange,
}: {
  op: ComparisonOp;
  value: string | number | boolean | null;
  primitiveKind: LogicField["primitiveKind"];
  onOpChange: (op: ComparisonOp) => void;
  onValueChange: (value: string | number | boolean | null) => void;
}) {
  return (
    <div className="flex gap-2">
      <div className="space-y-1.5">
        <Label className="text-xs">Operator</Label>
        <Select value={op} onValueChange={(v) => onOpChange(v as ComparisonOp)}>
          <SelectTrigger size="sm" data-testid="rule-operator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMPARISON_OPS.map((o) => (
              <SelectItem key={o} value={o}>
                {COMPARISON_OP_LABELS[o]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex-1 space-y-1.5">
        <Label className="text-xs">Value</Label>
        <ValueInput
          primitiveKind={primitiveKind}
          value={value}
          onChange={onValueChange}
        />
      </div>
    </div>
  );
}

// Character-length comparison row: operator + a whole-number character count.
// The count is always coerced to a non-negative integer, so the row stays
// valid; the model's conditionValid guards decompiled/hand-authored values.
function LengthCompareInputs({
  op,
  value,
  onOpChange,
  onValueChange,
}: {
  op: ComparisonOp;
  value: number;
  onOpChange: (op: ComparisonOp) => void;
  onValueChange: (value: number) => void;
}) {
  return (
    <div className="flex gap-2">
      <div className="space-y-1.5">
        <Label className="text-xs">Length is</Label>
        <Select value={op} onValueChange={(v) => onOpChange(v as ComparisonOp)}>
          <SelectTrigger size="sm" data-testid="rule-length-operator">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {COMPARISON_OPS.map((o) => (
              <SelectItem key={o} value={o}>
                {COMPARISON_OP_LABELS[o]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex-1 space-y-1.5">
        <Label className="text-xs">Characters</Label>
        <Input
          type="number"
          min={0}
          step={1}
          size="sm"
          value={String(value)}
          onChange={(e) => {
            const n = Number.parseInt(e.currentTarget.value, 10);
            onValueChange(Number.isFinite(n) && n >= 0 ? n : 0);
          }}
          data-testid="rule-length-value"
        />
      </div>
    </div>
  );
}

function ValueInput({
  primitiveKind,
  value,
  onChange,
}: {
  primitiveKind: LogicField["primitiveKind"];
  value: string | number | boolean | null;
  onChange: (v: string | number | boolean | null) => void;
}) {
  if (primitiveKind === "boolean") {
    return (
      <Select
        value={value === true ? "true" : value === false ? "false" : ""}
        onValueChange={(v) => onChange(v === "true")}
      >
        <SelectTrigger size="sm" data-testid="rule-value">
          <SelectValue placeholder="Pick" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="true">true</SelectItem>
          <SelectItem value="false">false</SelectItem>
        </SelectContent>
      </Select>
    );
  }
  if (primitiveKind === "number") {
    return (
      <Input
        type="number"
        size="sm"
        value={value === null || value === undefined ? "" : String(value)}
        onChange={(e) => {
          const raw = e.currentTarget.value;
          if (raw === "") {
            onChange(null);
            return;
          }
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : raw);
        }}
        data-testid="rule-value"
      />
    );
  }
  return (
    <Input
      type={primitiveKind === "date" ? "date" : "text"}
      size="sm"
      value={value === null || value === undefined ? "" : String(value)}
      onChange={(e) => onChange(e.currentTarget.value)}
      data-testid="rule-value"
    />
  );
}
