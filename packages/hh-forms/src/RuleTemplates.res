// Authoring-time helpers for the FieldLogicPanel UI.
//
// Two responsibilities:
//
//   1. `logicField` — abstracted field shape both event-form and
//      patient-registration-form adapt into, so the panel doesn't need to
//      know either form's native shape. Adapters live in each model;
//      this file just defines the contract.
//
//   2. `simpleVisibilityTemplate` — discriminated union covering the
//      "easy 80%" of visibility rules. The panel works in template mode
//      by default and falls back to a raw-JSON editor for rules that
//      don't decompile to a template.
//
// Rule reference convention: rules read fields by id via
// `{var: "form.<fieldId>"}`. The Rules.res evaluator mirrors this scope
// shape exactly.

// What kind of value a field collects. Drives which rule slots are
// allowed and which value-input widget renders in the panel.
//   - `primitive`   : binary / text / date / options / registration
//                     fields. All four rule slots apply.
//   - `list`        : medicine / diagnosis / file fields. Only visibleIf
//                     applies (per the data-model decision).
//   - `displayOnly` : text-display / separator. Only visibleIf applies.
@genType
type logicFieldKind = [#primitive | #list | #displayOnly]

// Narrower primitive-value type, used by the value input in the template
// UI. Only meaningful when `kind === #primitive`. `string` covers text /
// select / checkbox-as-value; `number`, `boolean`, `date` are the others.
@genType
type logicPrimitiveKind = [#string | #number | #boolean | #date]

// A selectable option on a multi-value field, surfaced to the panel's value
// picker. `value` is the token that lands in rule scope (event: option value;
// registration: option `en`); `label` is what the author sees.
@genType
type logicOption = {value: string, label: string}

@genType
type logicField = {
  id: string,
  displayName: string,
  kind: logicFieldKind,
  // Set when kind === #primitive. Drives value-input rendering.
  primitiveKind?: logicPrimitiveKind,
  // Set when the field holds multiple values (multi-select / checkbox); gates
  // the includes/excludes condition kinds and the option picker.
  multiValue?: bool,
  // Selectable options, present for option-backed fields.
  options?: array<logicOption>,
  // Set for free-text fields. Gates the length-comparison condition kind,
  // which is meaningless on option-backed, numeric, or multi-value fields.
  freeText?: bool,
}

// Comparison operators the simple template exposes. Mirrors the legacy
// TS COMPARISON_OPS array order — order matters for the operator
// picker UI.
@genType
type comparisonOp = [#"==" | #"!=" | #">" | #">=" | #"<" | #"<="]

// Exposed for consumers iterating the operator set (operator picker UI).
@genType
let comparisonOps: array<comparisonOp> = [#"==", #"!=", #">", #">=", #"<", #"<="]

// Human-readable labels for the operator picker. The dict shape preserves
// the legacy `Record<ComparisonOp, string>` ergonomics.
@genType
let comparisonOpLabels: dict<string> = {
  let d: dict<string> = Dict.make()
  d->Dict.set("==", "equals")
  d->Dict.set("!=", "does not equal")
  d->Dict.set(">", "is greater than")
  d->Dict.set(">=", "is greater than or equal to")
  d->Dict.set("<", "is less than")
  d->Dict.set("<=", "is less than or equal to")
  d
}

// A single leaf condition over one field. This is the reusable seam: a
// future nested/mixed boolean tree would wrap these leaves in group nodes
// without changing the leaf shape, and the serialized JSONLogic is
// identical either way (storage is always one rule).
//
// `Comparison` — comparison between a field reference and a literal.
// `Truthy`     — `{!!: {var: "form.<id>"}}` — field has any truthy value.
// `Falsy`      — `{!: {var: "form.<id>"}}` — field is empty / falsy.
//
// `value` in `Comparison` is JSON.t because the simple template accepts
// string / number / boolean / null literals — exactly the JSON primitive
// space minus arrays/objects. Callers narrow via JSON.t pattern matching.
@genType
type visibilityCondition =
  | Comparison({fieldId: string, op: comparisonOp, value: JSON.t})
  | Truthy({fieldId: string})
  | Falsy({fieldId: string})
  // Multi-value membership over a field's array. `IncludesOption`/`ExcludesOption`
  // compile to `in` / `!in`; `IncludesAny`/`IncludesAll` to `or`/`and`-of-`in`.
  | IncludesOption({fieldId: string, value: string})
  | ExcludesOption({fieldId: string, value: string})
  | IncludesAny({fieldId: string, values: array<string>})
  | IncludesAll({fieldId: string, values: array<string>})
  // "Is one of" over a SINGLE-valued option field. Compiles to `or`-of-`==`,
  // never `in`: the evaluator's `in` falls back to substring matching when the
  // haystack is a string (JsonLogic_Eval.evalIn), so `in` on a scalar select
  // would match "opt1" against a stored "opt10". Equality is exact.
  | EqualsAny({fieldId: string, values: array<string>})
  // Character-length comparison over a free-text field. Compiles to
  // `{<op>: [{length: [{var: [form.<id>, ""]}]}, <n>]}`. The var default ("")
  // coerces a missing/empty value to length 0 instead of an eval error, so an
  // absent field correctly fails a min-length rule — a broken `length` would
  // otherwise pass silently (see Rules.computeValidatorErrors).
  | LengthCompare({fieldId: string, op: comparisonOp, value: float})

// How a list of conditions combines. Both are authorable via the editor's
// AND/OR picker; a single condition canonically reports `#and`. Mixed logic
// (an AND of ORs) is out of scope — one flat list under one connector, and
// nested groups stay in advanced mode.
@genType
type connector = [#"and" | #"or"]

// `Always`     — no visibleIf rule; field is always visible.
// `Conditions` — one or more leaf conditions combined by `connector`.
//                A single condition compiles to the bare leaf rule (no
//                wrapper); two or more compile to `{and: [...]}` /
//                `{or: [...]}`. `conditions` is expected non-empty;
//                an empty list compiles to "no rule" defensively.
@genType
type simpleVisibilityTemplate =
  | Always
  | Conditions({connector: connector, conditions: array<visibilityCondition>})

let formVarPrefix = "form."

// Read the field id from a `{var: "form.<id>"}` rule, or None if the
// shape doesn't match. Used internally by the decompiler.
//
// Empty rest (path is exactly `"form."`) returns None: an empty fieldId
// is a malformed authoring shape, not a legitimate reference. Treating it
// as `Some("")` would let downstream `ruleReferencesField` match the empty
// target against any field whose id is also `""`, silently corrupting
// scope/cycle reasoning.
let isFormVar = (rule: JSON.t): option<string> =>
  switch rule {
  | Object(obj) =>
    switch obj->Dict.get("var") {
    | Some(String(path)) =>
      if String.startsWith(path, formVarPrefix) {
        let rest = String.sliceToEnd(path, ~start=String.length(formVarPrefix))
        if String.length(rest) > 0 {
          Some(rest)
        } else {
          None
        }
      } else {
        None
      }
    | _ => None
    }
  | _ => None
  }

// Comparison templates accept string / number / boolean / null literals.
// Arrays and objects are rejected — those shapes belong in advanced mode.
let isLiteral = (v: JSON.t): bool =>
  switch v {
  | Null | Boolean(_) | Number(_) | String(_) => true
  | _ => false
  }

// Compile one leaf condition into its JSONLogic rule object.
let compileCondition = (c: visibilityCondition): JSON.t => {
  let varRef = fieldId =>
    JSON.Object(Dict.fromArray([("var", JSON.String(formVarPrefix ++ fieldId))]))
  // `{in: [<option>, {var: form.<id>}]}` — membership on the field's array.
  let inRule = (fieldId, value) =>
    JSON.Object(Dict.fromArray([("in", JSON.Array([JSON.String(value), varRef(fieldId)]))]))
  let inGroup = (op, fieldId, values) =>
    JSON.Object(Dict.fromArray([(op, JSON.Array(values->Array.map(v => inRule(fieldId, v))))]))
  // `{"==": [{var: form.<id>}, <option>]}` — exact equality on a scalar field.
  let eqRule = (fieldId, value) =>
    JSON.Object(Dict.fromArray([("==", JSON.Array([varRef(fieldId), JSON.String(value)]))]))
  let eqGroup = (fieldId, values) =>
    JSON.Object(Dict.fromArray([("or", JSON.Array(values->Array.map(v => eqRule(fieldId, v))))]))
  // `{length: {var: [form.<id>, ""]}}` — the field's value length. The `length`
  // operand is a single rule (not array-wrapped, else it measures the wrapper);
  // the var default coerces a missing value to "" so length is 0, never an error.
  let lengthOfField = fieldId =>
    JSON.Object(
      Dict.fromArray([
        (
          "length",
          JSON.Object(
            Dict.fromArray([
              ("var", JSON.Array([JSON.String(formVarPrefix ++ fieldId), JSON.String("")])),
            ]),
          ),
        ),
      ]),
    )
  switch c {
  | Comparison({fieldId, op, value}) =>
    JSON.Object(Dict.fromArray([((op :> string), JSON.Array([varRef(fieldId), value]))]))
  | Truthy({fieldId}) => JSON.Object(Dict.fromArray([("!!", varRef(fieldId))]))
  | Falsy({fieldId}) => JSON.Object(Dict.fromArray([("!", varRef(fieldId))]))
  | IncludesOption({fieldId, value}) => inRule(fieldId, value)
  | ExcludesOption({fieldId, value}) =>
    JSON.Object(Dict.fromArray([("!", inRule(fieldId, value))]))
  | IncludesAny({fieldId, values}) => inGroup("or", fieldId, values)
  | IncludesAll({fieldId, values}) => inGroup("and", fieldId, values)
  | EqualsAny({fieldId, values}) => eqGroup(fieldId, values)
  | LengthCompare({fieldId, op, value}) =>
    JSON.Object(Dict.fromArray([((op :> string), JSON.Array([lengthOfField(fieldId), JSON.Number(value)]))]))
  }
}

// Compile a SimpleVisibilityTemplate into a JSONLogic rule.
//
// `Always` (and a defensively-empty condition list) returns `None` — the
// absence of a rule. A single condition compiles to the bare leaf rule so
// existing stored single-condition rules round-trip byte-identically; two
// or more wrap in `{and: [...]}` / `{or: [...]}`.
@genType
let compileVisibilityTemplate = (t: simpleVisibilityTemplate): option<JSON.t> =>
  switch t {
  | Always => None
  | Conditions({conditions}) if Array.length(conditions) === 0 => None
  | Conditions({conditions}) if Array.length(conditions) === 1 =>
    Some(compileCondition(Array.getUnsafe(conditions, 0)))
  | Conditions({connector, conditions}) =>
    Some(
      JSON.Object(
        Dict.fromArray([((connector :> string), JSON.Array(conditions->Array.map(compileCondition)))]),
      ),
    )
  }

let comparisonOpFromString = (s: string): option<comparisonOp> =>
  switch s {
  | "==" => Some(#"==")
  | "!=" => Some(#"!=")
  | ">" => Some(#">")
  | ">=" => Some(#">=")
  | "<" => Some(#"<")
  | "<=" => Some(#"<=")
  | _ => None
  }

// Read the field id from a unary boolean operand: either the direct
// `{var: "form.<id>"}` form or the legacy single-element array wrapper.
let unaryFieldId = (arg: JSON.t): option<string> =>
  switch isFormVar(arg) {
  | Some(id) => Some(id)
  | None =>
    switch arg {
    | Array(a) if Array.length(a) === 1 => isFormVar(a->Array.getUnsafe(0))
    | _ => None
    }
  }

// Read a membership leaf `{in: [<option>, {var: "form.<id>"}]}` — the
// option-first / var-second order compileCondition emits. The reverse order
// (`{in: [{var}, <str>]}`) is substring containment, a different rule that
// stays in advanced mode. Returns (fieldId, value).
let decompileInLeaf = (rule: JSON.t): option<(string, string)> =>
  switch rule {
  | Object(obj) =>
    switch Dict.keysToArray(obj) {
    | ["in"] =>
      switch obj->Dict.get("in")->Option.getUnsafe {
      | Array(args) if Array.length(args) === 2 =>
        switch (args->Array.getUnsafe(0), isFormVar(args->Array.getUnsafe(1))) {
        | (String(value), Some(fieldId)) => Some((fieldId, value))
        | _ => None
        }
      | _ => None
      }
    | _ => None
    }
  | _ => None
  }

// Collapse `{or|and: [in, in, …]}` into an IncludesAny / IncludesAll leaf, iff
// every member is a membership leaf over the SAME field and there are ≥2 of
// them. Any other member (mixed fields, a non-`in` leaf) returns None so the
// group falls back to the multi-condition editor.
let decompileInGroup = (op: string, items: array<JSON.t>): option<visibilityCondition> =>
  if Array.length(items) < 2 {
    None
  } else {
    let fieldId = ref(None)
    let values = []
    let ok = ref(true)
    let i = ref(0)
    while ok.contents && i.contents < Array.length(items) {
      switch decompileInLeaf(items->Array.getUnsafe(i.contents)) {
      | Some((f, v)) =>
        switch fieldId.contents {
        | None => fieldId := Some(f)
        | Some(existing) => if !String.equal(existing, f) { ok := false }
        }
        Array.push(values, v)
      | None => ok := false
      }
      i := i.contents + 1
    }
    switch (ok.contents, fieldId.contents) {
    | (true, Some(f)) if op == "or" => Some(IncludesAny({fieldId: f, values}))
    | (true, Some(f)) if op == "and" => Some(IncludesAll({fieldId: f, values}))
    | _ => None
    }
  }

// Read an equality leaf `{"==": [{var: "form.<id>"}, <string>]}` — the var-first
// order compileCondition emits for scalar option fields. Only string literals
// qualify; a numeric or boolean rhs is a plain Comparison.
let decompileEqLeaf = (rule: JSON.t): option<(string, string)> =>
  switch rule {
  | Object(obj) =>
    switch Dict.keysToArray(obj) {
    | ["=="] =>
      switch obj->Dict.get("==")->Option.getUnsafe {
      | Array(args) if Array.length(args) === 2 =>
        switch (isFormVar(args->Array.getUnsafe(0)), args->Array.getUnsafe(1)) {
        | (Some(fieldId), String(value)) => Some((fieldId, value))
        | _ => None
        }
      | _ => None
      }
    | _ => None
    }
  | _ => None
  }

// Collapse `{or: [==, ==, …]}` into an EqualsAny leaf, iff every member is an
// equality leaf over the SAME field and there are ≥2. Mirrors decompileInGroup.
let decompileEqGroup = (items: array<JSON.t>): option<visibilityCondition> =>
  if Array.length(items) < 2 {
    None
  } else {
    let fieldId = ref(None)
    let values = []
    let ok = ref(true)
    let i = ref(0)
    while ok.contents && i.contents < Array.length(items) {
      switch decompileEqLeaf(items->Array.getUnsafe(i.contents)) {
      | Some((f, v)) =>
        switch fieldId.contents {
        | None => fieldId := Some(f)
        | Some(existing) => if !String.equal(existing, f) { ok := false }
        }
        Array.push(values, v)
      | None => ok := false
      }
      i := i.contents + 1
    }
    switch (ok.contents, fieldId.contents) {
    | (true, Some(f)) => Some(EqualsAny({fieldId: f, values}))
    | _ => None
    }
  }

// Read a form field id from either `{var: "form.<id>"}` or the defaulted
// `{var: ["form.<id>", <default>]}` form (the latter is what LengthCompare
// emits). Rebuilds a bare-var object from the array head and reuses isFormVar.
let formVarIdWithDefault = (rule: JSON.t): option<string> =>
  switch rule {
  | Object(obj) =>
    switch obj->Dict.get("var") {
    | Some(String(_)) => isFormVar(rule)
    | Some(Array(a)) if Array.length(a) > 0 =>
      isFormVar(JSON.Object(Dict.fromArray([("var", Array.getUnsafe(a, 0))])))
    | _ => None
    }
  | _ => None
  }

// Read `{length: <form var>}` — the length-wrapped comparison LHS that a
// LengthCompare leaf carries. Returns the referenced field id.
let decompileLengthOperand = (rule: JSON.t): option<string> =>
  switch rule {
  | Object(obj) =>
    switch (Dict.keysToArray(obj), obj->Dict.get("length")) {
    | (["length"], Some(operand)) => formVarIdWithDefault(operand)
    | _ => None
    }
  | _ => None
  }

// Decompile a single bare leaf rule into a condition, or None if it doesn't
// match a leaf shape (comparison / length-comparison / truthy / falsy /
// includes / excludes / same-field includes-any/all group).
let decompileCondition = (rule: JSON.t): option<visibilityCondition> =>
  switch rule {
  | Object(obj) =>
    switch Dict.keysToArray(obj) {
    | [op] =>
      let arg = obj->Dict.get(op)->Option.getUnsafe
      // Comparison:    { "<op>": [{var: "form.<id>"}, <literal>] }
      // LengthCompare: { "<op>": [{length: [{var}]}, <non-negative int>] }
      switch comparisonOpFromString(op) {
      | Some(cop) =>
        switch arg {
        | Array(args) if Array.length(args) === 2 =>
          let lhs = args->Array.getUnsafe(0)
          let rhs = args->Array.getUnsafe(1)
          switch decompileLengthOperand(lhs) {
          | Some(fieldId) =>
            switch rhs {
            // Only non-negative integer bounds round-trip to the simple editor;
            // a fractional or negative bound stays in advanced mode.
            | Number(n) if n >= 0.0 && Int.toFloat(Float.toInt(n)) === n =>
              Some(LengthCompare({fieldId, op: cop, value: n}))
            | _ => None
            }
          | None =>
            switch isFormVar(lhs) {
            | Some(fieldId) if isLiteral(rhs) => Some(Comparison({fieldId, op: cop, value: rhs}))
            | _ => None
            }
          }
        | _ => None
        }
      | None =>
        switch op {
        // Truthy: { "!!": {var: "form.<id>"} }
        | "!!" => unaryFieldId(arg)->Option.map(id => Truthy({fieldId: id}))
        // Falsy: { "!": {var} }; ExcludesOption: { "!": {in: [...]} }
        | "!" =>
          switch decompileInLeaf(arg) {
          | Some((fieldId, value)) => Some(ExcludesOption({fieldId, value}))
          | None => unaryFieldId(arg)->Option.map(id => Falsy({fieldId: id}))
          }
        | "in" =>
          decompileInLeaf(JSON.Object(obj))->Option.map(pair => {
            let (fieldId, value) = pair
            IncludesOption({fieldId, value})
          })
        | "or" =>
          switch arg {
          // Membership group first, then the scalar `or`-of-`==` group. A mixed
          // list matches neither and falls through to the group path.
          | Array(items) =>
            switch decompileInGroup("or", items) {
            | Some(c) => Some(c)
            | None => decompileEqGroup(items)
            }
          | _ => None
          }
        | "and" =>
          switch arg {
          | Array(items) => decompileInGroup("and", items)
          | _ => None
          }
        | _ => None
        }
      }
    | _ => None
    }
  | _ => None
  }

// Decompile every element of an `and`/`or` argument list into a leaf
// condition. Returns None — conservatively dropping the whole group to
// advanced mode — if any element is a nested group or non-leaf shape.
let decompileConditions = (items: array<JSON.t>): option<array<visibilityCondition>> => {
  let out = []
  let ok = ref(true)
  let i = ref(0)
  while ok.contents && i.contents < Array.length(items) {
    switch decompileCondition(items->Array.getUnsafe(i.contents)) {
    | Some(c) => Array.push(out, c)
    | None => ok := false
    }
    i := i.contents + 1
  }
  ok.contents ? Some(out) : None
}

// Decompile a JSONLogic rule back into a SimpleVisibilityTemplate, or
// None if the rule doesn't match a template shape — meaning it was
// authored in advanced (raw-JSON) mode. `Null` / undefined-equivalent
// rules decompile to `Always`.
//
// Shapes recognised:
//   - missing / Null            → Always
//   - a single bare leaf        → Conditions(#and, [leaf])   (connector is
//                                 canonically #and for one condition)
//   - `{and|or: [leaf, leaf…]}` → Conditions(connector, leaves), iff every
//                                 element is a leaf and there are ≥2 of them
//
// Conservative by design: an `and`/`or` with <2 elements, a nested group,
// or any non-leaf member returns None and stays in advanced mode.
@genType
let decompileVisibilityTemplate = (rule: option<JSON.t>): option<simpleVisibilityTemplate> =>
  switch rule {
  | None | Some(Null) => Some(Always)
  | Some(Object(obj)) =>
    switch Dict.keysToArray(obj) {
    | [op] =>
      // Try the whole object as a single leaf first: this claims a same-field
      // `{or|and: [in, …]}` as an IncludesAny/IncludesAll leaf before the
      // group path below would read it as a multi-condition group.
      switch decompileCondition(JSON.Object(obj)) {
      | Some(c) => Some(Conditions({connector: #"and", conditions: [c]}))
      | None =>
        let arg = obj->Dict.get(op)->Option.getUnsafe
        let connectorOpt: option<connector> = switch op {
        | "and" => Some(#"and")
        | "or" => Some(#"or")
        | _ => None
        }
        switch connectorOpt {
        | Some(conn) =>
          switch arg {
          | Array(items) if Array.length(items) >= 2 =>
            decompileConditions(items)->Option.map(cs =>
              Conditions({connector: conn, conditions: cs})
            )
          | _ => None
          }
        | None => None
        }
      }
    | _ => None
    }
  | _ => None
  }

// Walks an arbitrary JSONLogic rule, returning true if any
// `{var: "form.<fieldId>"}` reference (including subpath access like
// `form.<fieldId>.foo`) is found.
//
// Used as an authoring-time guardrail: a validator placed on field A
// whose rule never references `form.A` is almost always a mistake; the
// UI surfaces a soft warning when this returns false.
//
// Pathological `var` shapes (`{var: {cat: [...]}}` — computed paths)
// are treated as non-references; we can't statically resolve them.
// Iterative tree walk; recursion would stack-overflow on the deeply-nested
// JSON the advanced-mode editor allows authors to paste. Same node-visit
// ceiling as RuleCycles for the same reason.
let maxWalkVisits: int = 50_000

@genType
let ruleReferencesField = (rule: option<JSON.t>, fieldId: string): bool =>
  if String.length(fieldId) === 0 {
    // An empty target would collapse to the bare prefix `"form."` and
    // match any rule that happens to contain `{var: "form."}` — a
    // malformed-rule shape, not a legitimate reference. Treat empty
    // fieldId as "no field" so callers don't get a misleading true.
    false
  } else {
    let target = formVarPrefix ++ fieldId
    let subpathPrefix = target ++ "."
  let pathMatches = (p: JSON.t): bool =>
    switch p {
    | String(s) => s === target || String.startsWith(s, subpathPrefix)
    | _ => false
    }
  let walk = (root: JSON.t): bool => {
    let stack: array<JSON.t> = [root]
    let found = ref(false)
    let visited = ref(0)
    while !found.contents && Array.length(stack) > 0 && visited.contents < maxWalkVisits {
      visited := visited.contents + 1
      let node = Array.pop(stack)->Option.getUnsafe
      // ReScript collapses our empty Null/Boolean/Number/String arms with
      // the catch-all and dispatches Object via `typeof === "object"`; in
      // JS, `typeof null === "object"`, so an unguarded match reads
      // `null["var"]` and throws. Classify explicitly via JSON.Classify
      // so null lands in the Null arm instead of the Object arm.
      switch JSON.Classify.classify(node) {
      | Array(items) => items->Array.forEach(r => Array.push(stack, r))
      | Object(obj) =>
        switch obj->Dict.get("var") {
        | Some(arg) =>
          if pathMatches(arg) {
            found := true
          } else {
            switch arg {
            | Array(a) if Array.length(a) > 0 =>
              if pathMatches(a[0]->Option.getUnsafe) {
                found := true
              }
            | _ => ()
            }
          }
        | None => obj->Dict.valuesToArray->Array.forEach(v => Array.push(stack, v))
        }
      | Null | Bool(_) | Number(_) | String(_) => ()
      }
    }
    found.contents
  }
  switch rule {
  | None | Some(Null) => false
  | Some(node) =>
    switch node {
    | Object(_) | Array(_) => walk(node)
    | _ => false
    }
  }
}

// Rewrite a `var` path's field id to `mapping`'s replacement, keeping any
// subpath. Paths outside the form scope, and ids the mapping doesn't cover,
// come back unchanged.
let remapVarPath = (mapping: dict<string>, path: string): string =>
  if String.startsWith(path, formVarPrefix) {
    let rest = String.sliceToEnd(path, ~start=String.length(formVarPrefix))
    let (fieldId, subpath) = switch String.indexOf(rest, ".") {
    | -1 => (rest, "")
    | idx => (String.slice(rest, ~start=0, ~end=idx), String.sliceToEnd(rest, ~start=idx))
    }
    switch mapping->Dict.get(fieldId) {
    | Some(replacement) => formVarPrefix ++ replacement ++ subpath
    | None => path
    }
  } else {
    path
  }

// The argument of a `var` node: the bare path, or the `[path, default]` array
// form whose default is copied through untouched, as the reference collectors
// also treat it as opaque.
let remapVarArg = (mapping: dict<string>, arg: JSON.t): JSON.t =>
  switch arg {
  | String(path) => JSON.String(remapVarPath(mapping, path))
  | Array(items) if Array.length(items) > 0 =>
    switch Array.getUnsafe(items, 0) {
    | String(path) =>
      let rewritten = Array.copy(items)
      Array.setUnsafe(rewritten, 0, JSON.String(remapVarPath(mapping, path)))
      JSON.Array(rewritten)
    | _ => arg
    }
  | _ => arg
  }

// Rewrite every `{var: "form.<fieldId>"}` reference in a rule into a fresh
// tree, leaving the input untouched. Duplicating a form mints new field ids,
// and its rules have to follow or they silently read the original's fields.
//
// Computed paths (`{var: {cat: [...]}}`) can't be resolved statically and are
// copied verbatim, matching `ruleReferencesField`.
//
// `None` means the walk hit its node ceiling. The half-rebuilt tree would
// carry stale references, and a rule quietly reading another form's field is
// worse than a refused duplication.
@genType
let remapFormFieldRefs = (rule: JSON.t, mapping: dict<string>): option<JSON.t> => {
  // Each frame carries the setter that drops its rewritten node into the
  // already-published parent, so one pre-order pass suffices. Iterative for the
  // same reason the walkers above are — user JSON can nest past the JS stack.
  let rebuilt = ref(JSON.Null)
  let stack: array<(JSON.t, JSON.t => unit)> = [(rule, node => rebuilt := node)]
  let visited = ref(0)
  while Array.length(stack) > 0 && visited.contents < maxWalkVisits {
    visited := visited.contents + 1
    let (node, place) = Array.pop(stack)->Option.getUnsafe
    // Classify explicitly — see the note in `ruleReferencesField` on why a
    // bare match would send `null` down the Object arm.
    switch JSON.Classify.classify(node) {
    | Array(items) =>
      let out = Array.make(~length=Array.length(items), JSON.Null)
      place(JSON.Array(out))
      items->Array.forEachWithIndex((item, index) =>
        Array.push(stack, (item, node => Array.setUnsafe(out, index, node)))
      )
    | Object(obj) =>
      let out = Dict.make()
      place(JSON.Object(out))
      obj
      ->Dict.toArray
      ->Array.forEach(((key, value)) =>
        if key === "var" {
          out->Dict.set(key, remapVarArg(mapping, value))
        } else {
          Array.push(stack, (value, node => out->Dict.set(key, node)))
        }
      )
    | Null | Bool(_) | Number(_) | String(_) => place(node)
    }
  }
  if Array.length(stack) > 0 {
    None
  } else {
    Some(rebuilt.contents)
  }
}
