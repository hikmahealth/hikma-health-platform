import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import fc from "fast-check";
import {
  PrescriptionsList,
  PrescriptionRow,
  formatPrescriptionDate,
  statusLabel,
  summarizePrescriptionStatuses,
} from "@/components/patient/PrescriptionsList";
import type Prescription from "@/models/prescription";

// Pure function tests

describe("formatPrescriptionDate", () => {
  it('returns "—" for null/undefined', () => {
    expect(formatPrescriptionDate(null)).toBe("—");
    expect(formatPrescriptionDate(undefined)).toBe("—");
  });

  it("always returns a non-empty string for any date input", () => {
    fc.assert(
      fc.property(fc.date(), (d) => {
        const result = formatPrescriptionDate(d);
        expect(typeof result).toBe("string");
        expect(result.length).toBeGreaterThan(0);
      }),
    );
  });

  it("formats valid dates into a readable string", () => {
    const d = new Date("2024-06-15T10:30:00Z");
    const result = formatPrescriptionDate(d);
    expect(result).not.toBe("—");
    expect(result).toContain("2024");
  });
});

describe("statusLabel", () => {
  it("capitalises single words", () => {
    expect(statusLabel("pending")).toBe("Pending");
    expect(statusLabel("cancelled")).toBe("Cancelled");
  });

  it("capitalises each hyphen-separated word", () => {
    expect(statusLabel("picked-up")).toBe("Picked Up");
    expect(statusLabel("not-picked-up")).toBe("Not Picked Up");
  });

  it("never returns an empty string for non-empty input", () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 30 }), (s) => {
        expect(statusLabel(s).length).toBeGreaterThan(0);
      }),
    );
  });
});

describe("summarizePrescriptionStatuses", () => {
  const knownStatuses = [
    "pending",
    "prepared",
    "picked-up",
    "not-picked-up",
    "partially-picked-up",
    "cancelled",
    "other",
  ];

  const countsArb = fc.array(
    fc.record({
      status: fc.oneof(
        fc.constantFrom(...knownStatuses),
        fc.string({ maxLength: 12 }),
        fc.constant(null),
      ),
      count: fc.integer({ min: -5, max: 500 }),
    }),
    { maxLength: 12 },
  );

  it("keeps total equal to the sum of the buckets", () => {
    fc.assert(
      fc.property(countsArb, (counts) => {
        const summary = summarizePrescriptionStatuses(counts);
        const summed = summary.byStatus.reduce((sum, e) => sum + e.count, 0);
        expect(summary.total).toBe(summed);
      }),
    );
  });

  it("conserves every positive count, including unknown statuses", () => {
    fc.assert(
      fc.property(countsArb, (counts) => {
        const expected = counts
          .filter((c) => c.count > 0)
          .reduce((sum, c) => sum + c.count, 0);
        expect(summarizePrescriptionStatuses(counts).total).toBe(expected);
      }),
    );
  });

  it("emits no zero or negative buckets", () => {
    fc.assert(
      fc.property(countsArb, (counts) => {
        for (const entry of summarizePrescriptionStatuses(counts).byStatus) {
          expect(entry.count).toBeGreaterThan(0);
        }
      }),
    );
  });

  it("emits each status at most once", () => {
    fc.assert(
      fc.property(countsArb, (counts) => {
        const seen = summarizePrescriptionStatuses(counts).byStatus.map(
          (e) => e.status,
        );
        expect(new Set(seen).size).toBe(seen.length);
      }),
    );
  });

  it("merges rows that repeat a status", () => {
    const summary = summarizePrescriptionStatuses([
      { status: "pending", count: 2 },
      { status: "pending", count: 3 },
    ]);
    expect(summary.byStatus).toEqual([{ status: "pending", count: 5 }]);
    expect(summary.total).toBe(5);
  });

  it('folds a null or blank status into "other"', () => {
    const summary = summarizePrescriptionStatuses([
      { status: null, count: 1 },
      { status: "   ", count: 2 },
      { status: "other", count: 3 },
    ]);
    expect(summary.byStatus).toEqual([{ status: "other", count: 6 }]);
  });

  it("orders known statuses by lifecycle, not by count", () => {
    const summary = summarizePrescriptionStatuses([
      { status: "cancelled", count: 9 },
      { status: "pending", count: 1 },
      { status: "picked-up", count: 5 },
    ]);
    expect(summary.byStatus.map((e) => e.status)).toEqual([
      "pending",
      "picked-up",
      "cancelled",
    ]);
  });

  it("sorts unknown statuses after known ones, stably", () => {
    const summary = summarizePrescriptionStatuses([
      { status: "zeta", count: 1 },
      { status: "alpha", count: 1 },
      { status: "cancelled", count: 1 },
    ]);
    expect(summary.byStatus.map((e) => e.status)).toEqual([
      "cancelled",
      "alpha",
      "zeta",
    ]);
  });

  it("returns an empty summary for no counts", () => {
    expect(summarizePrescriptionStatuses([])).toEqual({
      total: 0,
      byStatus: [],
    });
  });
});

// Arbitrary for Prescription.EncodedT

const statusArb = fc.constantFrom(
  "pending",
  "prepared",
  "picked-up",
  "not-picked-up",
  "partially-picked-up",
  "cancelled",
  "other",
);

const priorityArb = fc.constantFrom("high", "low", "normal", "emergency");

const prescriptionArb: fc.Arbitrary<Prescription.EncodedT> = fc.record({
  id: fc.uuid(),
  patient_id: fc.uuid(),
  provider_id: fc.uuid(),
  filled_by: fc.constant(null),
  pickup_clinic_id: fc.uuid(),
  visit_id: fc.option(fc.uuid(), { nil: null }),
  priority: priorityArb,
  expiration_date: fc.option(
    fc.date({ min: new Date("2024-01-01"), max: new Date("2030-01-01") }),
    { nil: null },
  ),
  prescribed_at: fc.date({
    min: new Date("2020-01-01"),
    max: new Date("2030-01-01"),
  }),
  filled_at: fc.constant(null),
  status: statusArb,
  items: fc.constant([]),
  notes: fc.string({ maxLength: 100 }),
  metadata: fc.constant({}),
  is_deleted: fc.constant(false),
  created_at: fc.date({
    min: new Date("2020-01-01"),
    max: new Date("2030-01-01"),
  }),
  updated_at: fc.date({
    min: new Date("2020-01-01"),
    max: new Date("2030-01-01"),
  }),
  deleted_at: fc.constant(null),
  last_modified: fc.date({
    min: new Date("2020-01-01"),
    max: new Date("2030-01-01"),
  }),
  server_created_at: fc.date({
    min: new Date("2020-01-01"),
    max: new Date("2030-01-01"),
  }),
});

// Component tests

describe("PrescriptionRow", () => {
  it("always shows a status badge", () => {
    fc.assert(
      fc.property(prescriptionArb, (rx) => {
        const { container, unmount } = render(
          <PrescriptionRow prescription={rx} />,
        );
        const view = within(container);
        expect(view.getByText(statusLabel(rx.status))).toBeDefined();
        unmount();
      }),
      { numRuns: 20 },
    );
  });

  it("shows priority badge only for non-normal priorities", () => {
    fc.assert(
      fc.property(
        prescriptionArb.filter(
          (rx) => rx.priority !== null && rx.priority !== "normal",
        ),
        (rx) => {
          const { container, unmount } = render(
            <PrescriptionRow prescription={rx} />,
          );
          const view = within(container);
          expect(view.getByText(rx.priority as string)).toBeDefined();
          unmount();
        },
      ),
      { numRuns: 10 },
    );
  });
});

describe("PrescriptionsList", () => {
  const emptyPag = { offset: 0, limit: 10, total: 0, hasMore: false };
  const noop = () => {};

  it("shows empty message when no prescriptions", () => {
    render(
      <PrescriptionsList
        prescriptions={[]}
        pagination={emptyPag}
        onPageChange={noop}
      />,
    );
    expect(screen.getByText("No prescriptions recorded")).toBeDefined();
  });

  it("renders one row per prescription", () => {
    fc.assert(
      fc.property(
        fc.array(prescriptionArb, { minLength: 1, maxLength: 5 }),
        (rxs) => {
          const pag = {
            offset: 0,
            limit: 10,
            total: rxs.length,
            hasMore: false,
          };
          const { container, unmount } = render(
            <PrescriptionsList
              prescriptions={rxs}
              pagination={pag}
              onPageChange={noop}
            />,
          );
          const rows = container.querySelectorAll(".border.rounded-lg.p-4");
          expect(rows.length).toBe(rxs.length);
          unmount();
        },
      ),
      { numRuns: 10 },
    );
  });

  it("omits the summary line when no counts are supplied", () => {
    render(
      <PrescriptionsList
        prescriptions={[]}
        pagination={emptyPag}
        onPageChange={noop}
      />,
    );
    expect(screen.queryByText(/total/)).toBeNull();
  });

  it("summarises across all pages, not just the rendered page", () => {
    render(
      <PrescriptionsList
        prescriptions={[]}
        pagination={{ offset: 0, limit: 10, total: 12, hasMore: false }}
        statusCounts={[
          { status: "pending", count: 7 },
          { status: "picked-up", count: 5 },
        ]}
        onPageChange={noop}
      />,
    );
    expect(
      screen.getByText("12 total · 7 pending · 5 picked up"),
    ).toBeDefined();
  });

  it("keeps the summary line out of the prescription row count", () => {
    const rx = fc.sample(prescriptionArb, 1)[0]!;
    const { container } = render(
      <PrescriptionsList
        prescriptions={[rx]}
        pagination={{ offset: 0, limit: 10, total: 1, hasMore: false }}
        statusCounts={[{ status: rx.status, count: 1 }]}
        onPageChange={noop}
      />,
    );
    expect(container.querySelectorAll(".border.rounded-lg.p-4").length).toBe(1);
  });
});
