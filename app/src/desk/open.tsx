// SPDX-FileCopyrightText: 2026 Junctura Contributors
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button, ErrorState, SelectField, TextAreaField, TextField } from "@junctura/ui";
import { generateReference, referencePrefix, unitGroupIds, usePackState, type PackWorkflow } from "../pack/data";
import { isDeskApiError, useDesk } from "./context";
import { latestDefinitionBy, type DefinitionItem } from "./data";
import { REFERENCE_PATTERN } from "../pack/data";
import { DeskPage } from "./layout";
import { DeskEmpty, DeskError, DeskLoading } from "./states";
import { deskStrings as s } from "./strings";

/**
 * Open case: start a workflow of the installed pack. Which workflows exist,
 * which groups may open them and what the open form asks all come from the
 * pack; only the reference code is the portal's own field.
 */

/** Renders the pack's open form fields, one controlled input per field. */
function PackOpenFields({ workflow, values, onChange }: {
  workflow: PackWorkflow;
  values: Readonly<Record<string, string>>;
  onChange: (id: string, value: string) => void;
}) {
  const unsupported = workflow.open.form.fields.filter(field => field.type === "file");
  return (
    <>
      {workflow.open.form.fields.map(field => {
        if (field.type === "file") return null;
        const common = { label: field.label, required: field.required === true, value: values[field.id] ?? "" };
        if (field.type === "text-multiline") {
          return (
            <TextAreaField key={field.id} {...common} rows={3}
              onChange={event => onChange(field.id, event.target.value)} />
          );
        }
        if (field.type === "select") {
          return (
            <SelectField key={field.id} {...common}
              options={(field.options ?? []).map(option => ({ value: option, label: option }))}
              placeholder={field.required ? undefined : "—"}
              onChange={event => onChange(field.id, event.target.value)} />
          );
        }
        return (
          <TextField key={field.id} {...common}
            type={field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
            onChange={event => onChange(field.id, event.target.value)} />
        );
      })}
      {unsupported.length > 0 && (
        <p className="text-xs text-muted">
          {s.openCase.unsupportedFields} {unsupported.map(field => field.label).join(", ")}
        </p>
      )}
    </>
  );
}

export function OpenCasePage() {
  const { pack, failed } = usePackState();
  const { api, staff } = useDesk();
  const [definitions, setDefinitions] = useState<Record<string, DefinitionItem> | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);

  const load = useCallback(() => {
    setLoadError(null);
    setDefinitions(null);
    return api.getJson<{ items: readonly DefinitionItem[] }>("/v1/workflows/definitions")
      .then(list => setDefinitions(latestDefinitionBy(list.items)))
      .catch(setLoadError);
  }, [api]);

  useEffect(() => { void load(); }, [load]);

  const openable = useMemo(() => {
    if (!pack) return [];
    const groups = new Set(unitGroupIds(staff));
    return pack.workflows.filter(candidate => groups.has(candidate.open.role));
  }, [pack, staff]);

  if (loadError) {
    return (
      <DeskPage title={s.openCase.title} lead={s.openCase.lead} current="/ho-so/mo">
        <DeskError error={loadError} onRetry={() => void load()} />
      </DeskPage>
    );
  }
  if (failed) {
    return (
      <DeskPage title={s.openCase.title} lead={s.openCase.lead} current="/ho-so/mo">
        <ErrorState title={s.errors.packTitle} onRetry={() => window.location.reload()}>{s.errors.pack}</ErrorState>
      </DeskPage>
    );
  }
  if (!definitions || !pack) {
    return (
      <DeskPage title={s.openCase.title} lead={s.openCase.lead} current="/ho-so/mo">
        <DeskLoading lines={3} />
      </DeskPage>
    );
  }
  const deployed = openable.filter(candidate => candidate.id in definitions);
  if (deployed.length === 0) {
    return (
      <DeskPage title={s.openCase.title} lead={s.openCase.lead} current="/ho-so/mo">
        <DeskEmpty title={s.openCase.noWorkflow} />
      </DeskPage>
    );
  }
  return <OpenCaseForm definitions={definitions} openable={deployed} />;
}

function OpenCaseForm({ definitions, openable }: {
  definitions: Record<string, DefinitionItem>;
  openable: readonly PackWorkflow[];
}) {
  const { api, staff } = useDesk();
  const [workflow, setWorkflow] = useState(openable[0]);
  const [reference, setReference] = useState(() => generateReference(referencePrefix(openable[0].id)));
  const [values, setValues] = useState<Readonly<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [apiError, setApiError] = useState<unknown>(null);
  const [submitting, setSubmitting] = useState(false);
  // The same key on repeated clicks makes retries safe; a fresh key only on a new case.
  const idempotencyKey = useRef<string | null>(null);

  const changeWorkflow = (nextId: string) => {
    const next = openable.find(candidate => candidate.id === nextId) ?? openable[0];
    setWorkflow(next);
    setReference(generateReference(referencePrefix(next.id)));
    setValues({});
    setFormError(null);
  };

  const submit = async () => {
    if (!REFERENCE_PATTERN.test(reference)) {
      setFormError(s.openCase.referenceInvalid);
      return;
    }
    if (workflow.open.form.fields.some(field => field.required === true && !(values[field.id] ?? "").trim())) {
      setFormError(s.openCase.requiredEmpty);
      return;
    }
    setFormError(null);
    setApiError(null);
    setSubmitting(true);
    idempotencyKey.current ??= crypto.randomUUID();
    try {
      const created = await api.postJson<{ id?: string }>("/v1/workflows/executions", {
        definitionId: definitions[workflow.id].id,
        input: {
          reference,
          openedBy: staff.facility,
          ...Object.fromEntries(workflow.open.form.fields.map(field => [field.id, values[field.id] ?? ""])),
        },
      }, { idempotencyKey: idempotencyKey.current });
      if (created?.id) {
        window.location.hash = `#/ho-so/${created.id}`;
        return;
      }
      setApiError(null);
      setFormError(s.openCase.failed);
    } catch (error) {
      setApiError(error);
      setFormError(isDeskApiError(error) ? null : s.openCase.failed);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <DeskPage title={s.openCase.title} lead={s.openCase.lead} current="/ho-so/mo">
      <form
        noValidate
        className="max-w-xl space-y-5 rounded-lg border border-line bg-surface p-5 shadow-card"
        onSubmit={event => { event.preventDefault(); void submit(); }}
      >
        <SelectField
          label={s.openCase.workflow}
          value={workflow.id}
          onChange={event => changeWorkflow(event.target.value)}
          options={openable.map(option => ({ value: option.id, label: option.name }))}
        />
        <TextField
          label={s.openCase.reference}
          hint={s.openCase.referenceHint}
          error={formError === s.openCase.referenceInvalid ? formError : undefined}
          value={reference}
          onChange={event => { setReference(event.target.value); setFormError(null); }}
          className="font-mono uppercase"
        />
        <PackOpenFields
          workflow={workflow}
          values={values}
          onChange={(id, value) => { setValues(current => ({ ...current, [id]: value })); setFormError(null); }}
        />
        {formError && formError !== s.openCase.referenceInvalid && (
          <p role="alert" className="text-sm font-medium text-danger">{formError}</p>
        )}
        {apiError ? <DeskError error={apiError} onRetry={() => void submit()} /> : null}
        <Button type="submit" size="lg" loading={submitting}>{submitting ? s.openCase.submitting : s.openCase.submit}</Button>
        <p className="rounded-lg border border-dashed border-line bg-surface-2 px-4 py-3 text-sm text-ink-2">{s.openCase.noSensitiveNote}</p>
      </form>
    </DeskPage>
  );
}
