"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/apiClient";
import { useAuth } from "@/components/AuthContext";

interface Lookup {
  id: string;
  key: string;
  label: string;
  phase?: string;
  sequenceOrder?: number;
}

interface SiteContact {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  role: string | null;
}

interface SiteDocumentRequirement {
  id: string;
  requirementTypeId: string;
  requirementType: { id: string; key: string; label: string };
  required: boolean;
  status: string;
  documentUrl: string | null;
  notes: string | null;
}

interface RecdDelivery {
  id: string;
  productId: string | null;
  product: { id: string; name: string; model: string } | null;
  quantity: number | null;
  deliveryStatus: string;
  statusNote: string | null;
  priority: number | null;
  expectedDate: string | null;
  actualDate: string | null;
}

interface SiteDetail {
  id: string;
  address: string | null;
  companyName: string | null;
  gpsLat: string | null;
  gpsLng: string | null;
  confirmedExhaustHookupType: string | null;
  photosDriveFolderId: string | null;
  photosDriveFolderUrl: string | null;
  drawingsDriveFolderId: string | null;
  drawingsDriveFolderUrl: string | null;
  order: {
    id: string;
    orderNumber: string;
    plannedExhaustHookupType: string | null;
    customer: { name: string };
    quantity: number;
    product: { id: string; name: string; model: string };
    lineItems: Array<{ id: string; quantity: number; product: { id: string; name: string; model: string } }>;
  };
  currentStage: { id: string; label: string; phase: string };
  assignedEngineer: { name: string } | null;
  vendor: { id: string; name: string } | null;
  stageEvents: Array<{
    id: string;
    comment: string;
    createdAt: string;
    stageDefinition: { label: string };
    statusOption: { label: string };
    createdBy: { name: string };
  }>;
  photos: Array<{ id: string; photoUrl: string; checkpoint: { label: string }; uploadedAt: string }>;
  pendingActions: Array<{ id: string; description: string; status: string; category: string }>;
  contacts: SiteContact[];
  documentRequirements: SiteDocumentRequirement[];
  recdDelivery: RecdDelivery | null;
}

const DELIVERY_STATUS_OPTIONS = [
  { value: "pending", label: "Pending" },
  { value: "in_transit", label: "In transit" },
  { value: "delivered", label: "Delivered" },
];

const EXHAUST_OPTIONS = [
  { value: "replace_existing_silencer", label: "Replace existing silencer with RECD" },
  { value: "add_after_existing_exhaust", label: "Add RECD after existing exhaust" },
];

function mapsUrl(address: string | null, lat: string | null, lng: string | null): string | null {
  if (lat && lng) return `https://www.google.com/maps?q=${lat},${lng}`;
  if (address) return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
  return null;
}

function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function SiteDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { hasPermission } = useAuth();
  const canEdit = hasPermission("change_site_status");
  const canAssignVendor = hasPermission("manage_vendors");
  const canManageOrders = hasPermission("manage_orders");

  const [site, setSite] = useState<SiteDetail | null>(null);
  const [stages, setStages] = useState<Lookup[]>([]);
  const [statusOptions, setStatusOptions] = useState<Lookup[]>([]);
  const [checkpoints, setCheckpoints] = useState<Lookup[]>([]);
  const [vendors, setVendors] = useState<{ id: string; name: string; status: string }[]>([]);
  const [assignVendorId, setAssignVendorId] = useState("");
  const [assigningVendor, setAssigningVendor] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  // Update form
  const [stageId, setStageId] = useState("");
  const [statusId, setStatusId] = useState("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Exhaust confirm
  const [exhaustType, setExhaustType] = useState(EXHAUST_OPTIONS[0].value);
  const [matchesPlan, setMatchesPlan] = useState(true);
  const [submittingExhaust, setSubmittingExhaust] = useState(false);

  // Location
  const [locAddress, setLocAddress] = useState("");
  const [locLat, setLocLat] = useState("");
  const [locLng, setLocLng] = useState("");
  const [savingLocation, setSavingLocation] = useState(false);

  // Photos
  const [uploadingCheckpoint, setUploadingCheckpoint] = useState<string | null>(null);
  const photoInputRef = useRef<Record<string, HTMLInputElement | null>>({});

  // Site details (company name / address, office-side editing)
  const [companyName, setCompanyName] = useState("");
  const [detailsAddress, setDetailsAddress] = useState("");
  const [savingDetails, setSavingDetails] = useState(false);

  // Contacts
  const [contactName, setContactName] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactRole, setContactRole] = useState("");
  const [addingContact, setAddingContact] = useState(false);

  // Document requirements
  const [requirementTypes, setRequirementTypes] = useState<{ id: string; key: string; label: string }[]>([]);
  const [requirementState, setRequirementState] = useState<Record<string, { required: boolean; status: string }>>({});
  const [savingRequirements, setSavingRequirements] = useState(false);

  // RECD delivery
  const [products, setProducts] = useState<{ id: string; name: string; model: string }[]>([]);
  const [deliveryProductId, setDeliveryProductId] = useState("");
  const [deliveryQuantity, setDeliveryQuantity] = useState("1");
  const [deliveryStatus, setDeliveryStatus] = useState("pending");
  const [deliveryPriority, setDeliveryPriority] = useState("");
  const [deliveryNote, setDeliveryNote] = useState("");
  const [savingDelivery, setSavingDelivery] = useState(false);

  // Add another unit (either onto this order, or as a fully separate order)
  const [unitProductId, setUnitProductId] = useState("");
  const [unitQuantity, setUnitQuantity] = useState("1");
  const [unitMode, setUnitMode] = useState<"same_order" | "separate_order">("same_order");
  const [addingUnit, setAddingUnit] = useState(false);
  const [removingLineItemId, setRemovingLineItemId] = useState<string | null>(null);

  // Drive folders
  const [creatingDriveFolders, setCreatingDriveFolders] = useState(false);

  const load = useCallback(async () => {
    try {
      const detail = await api<SiteDetail>(`/sites/${id}`);
      setSite(detail);
      setStageId((prev) => prev || detail.currentStage.id);
      setAssignVendorId((prev) => prev || detail.vendor?.id || "");
      setLocAddress((prev) => prev || detail.address || "");
      setLocLat((prev) => prev || detail.gpsLat || "");
      setLocLng((prev) => prev || detail.gpsLng || "");
      setCompanyName((prev) => prev || detail.companyName || "");
      setDetailsAddress((prev) => prev || detail.address || "");
      setRequirementState((prev) =>
        Object.keys(prev).length
          ? prev
          : Object.fromEntries(
              detail.documentRequirements.map((r) => [r.requirementTypeId, { required: r.required, status: r.status }]),
            ),
      );
      if (detail.recdDelivery) {
        setDeliveryProductId((prev) => prev || detail.recdDelivery?.productId || "");
        setDeliveryQuantity((prev) => (prev !== "1" ? prev : String(detail.recdDelivery?.quantity ?? 1)));
        setDeliveryStatus((prev) => (prev !== "pending" ? prev : detail.recdDelivery?.deliveryStatus ?? "pending"));
        setDeliveryPriority((prev) => prev || (detail.recdDelivery?.priority != null ? String(detail.recdDelivery.priority) : ""));
        setDeliveryNote((prev) => prev || detail.recdDelivery?.statusNote || "");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load site");
    }
  }, [id]);

  useEffect(() => {
    load();
    api<Lookup[]>("/meta/stages").then(setStages).catch(() => {});
    api<Lookup[]>("/meta/status-options").then((opts) => {
      setStatusOptions(opts);
      if (opts.length) setStatusId((prev) => prev || opts[0].id);
    }).catch(() => {});
    api<Lookup[]>("/meta/photo-checkpoints").then(setCheckpoints).catch(() => {});
    api<{ id: string; key: string; label: string }[]>("/meta/document-requirement-types").then(setRequirementTypes).catch(() => {});
    api<{ id: string; name: string; model: string }[]>("/meta/products").then(setProducts).catch(() => {});
    if (canAssignVendor) api<{ id: string; name: string; status: string }[]>("/vendors").then(setVendors).catch(() => {});
  }, [load, canAssignVendor]);

  function flash(message: string) {
    setBanner(message);
    setTimeout(() => setBanner(null), 4000);
  }

  async function submitUpdate(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api(`/sites/${id}/stage-events`, {
        method: "POST",
        body: JSON.stringify({ stageDefinitionId: stageId, statusOptionId: statusId, comment }),
      });
      setComment("");
      flash("Update posted.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to post update");
    } finally {
      setSubmitting(false);
    }
  }

  async function submitLocation(e: React.FormEvent) {
    e.preventDefault();
    setSavingLocation(true);
    setError(null);
    try {
      await api(`/sites/${id}/location`, {
        method: "POST",
        body: JSON.stringify({
          address: locAddress || undefined,
          gpsLat: locLat.trim() === "" ? null : parseFloat(locLat),
          gpsLng: locLng.trim() === "" ? null : parseFloat(locLng),
        }),
      });
      flash("Location updated.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update location");
    } finally {
      setSavingLocation(false);
    }
  }

  async function submitAssignVendor(e: React.FormEvent) {
    e.preventDefault();
    setAssigningVendor(true);
    setError(null);
    try {
      await api(`/sites/${id}/assign-vendor`, {
        method: "POST",
        body: JSON.stringify({ vendorId: assignVendorId || null }),
      });
      flash("Vendor assigned.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to assign vendor");
    } finally {
      setAssigningVendor(false);
    }
  }

  async function submitExhaust(e: React.FormEvent) {
    e.preventDefault();
    setSubmittingExhaust(true);
    setError(null);
    try {
      const res = await api<{ pendingAction: unknown | null }>(`/sites/${id}/confirm-exhaust-hookup`, {
        method: "POST",
        body: JSON.stringify({ confirmedExhaustHookupType: exhaustType, matchesPlan }),
      });
      flash(
        res.pendingAction
          ? "Mismatch recorded - sent to the customer to decide."
          : "Exhaust hookup confirmed.",
      );
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm exhaust hookup");
    } finally {
      setSubmittingExhaust(false);
    }
  }

  async function uploadPhoto(checkpointId: string, file: File) {
    setUploadingCheckpoint(checkpointId);
    setError(null);
    try {
      const photoUrl = await fileToDataUrl(file);
      await api(`/sites/${id}/photos`, {
        method: "POST",
        body: JSON.stringify({ checkpointId, photoUrl }),
      });
      flash("Photo uploaded.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload photo");
    } finally {
      setUploadingCheckpoint(null);
    }
  }

  async function submitSiteDetails(e: React.FormEvent) {
    e.preventDefault();
    setSavingDetails(true);
    setError(null);
    try {
      await api(`/sites/${id}`, {
        method: "PATCH",
        body: JSON.stringify({ companyName: companyName || null, address: detailsAddress || null }),
      });
      flash("Site details updated.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update site details");
    } finally {
      setSavingDetails(false);
    }
  }

  async function addContact(e: React.FormEvent) {
    e.preventDefault();
    if (!contactName.trim()) return;
    setAddingContact(true);
    setError(null);
    try {
      await api(`/sites/${id}/contacts`, {
        method: "POST",
        body: JSON.stringify({ name: contactName, phone: contactPhone || undefined, role: contactRole || undefined }),
      });
      setContactName("");
      setContactPhone("");
      setContactRole("");
      flash("Contact added.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add contact");
    } finally {
      setAddingContact(false);
    }
  }

  async function removeContact(contactId: string) {
    setError(null);
    try {
      await api(`/sites/${id}/contacts/${contactId}`, { method: "DELETE" });
      flash("Contact removed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove contact");
    }
  }

  async function saveDocumentRequirements(e: React.FormEvent) {
    e.preventDefault();
    setSavingRequirements(true);
    setError(null);
    try {
      await api(`/sites/${id}/document-requirements`, {
        method: "PUT",
        body: JSON.stringify({
          requirements: requirementTypes.map((t) => ({
            requirementTypeId: t.id,
            required: requirementState[t.id]?.required ?? false,
            status: requirementState[t.id]?.status || undefined,
          })),
        }),
      });
      flash("Document requirements saved.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save document requirements");
    } finally {
      setSavingRequirements(false);
    }
  }

  async function saveDelivery(e: React.FormEvent) {
    e.preventDefault();
    setSavingDelivery(true);
    setError(null);
    try {
      await api(`/sites/${id}/recd-delivery`, {
        method: "PUT",
        body: JSON.stringify({
          productId: deliveryProductId || null,
          quantity: deliveryQuantity ? parseInt(deliveryQuantity, 10) : null,
          deliveryStatus,
          statusNote: deliveryNote || null,
          priority: deliveryPriority ? parseInt(deliveryPriority, 10) : null,
        }),
      });
      flash("RECD delivery updated.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update RECD delivery");
    } finally {
      setSavingDelivery(false);
    }
  }

  async function addUnit(e: React.FormEvent) {
    e.preventDefault();
    if (!site || !unitProductId) return;
    setAddingUnit(true);
    setError(null);
    try {
      const quantity = parseInt(unitQuantity, 10) || 1;
      if (unitMode === "same_order") {
        await api(`/orders/${site.order.id}/line-items`, {
          method: "POST",
          body: JSON.stringify({ productId: unitProductId, quantity }),
        });
        setUnitProductId("");
        setUnitQuantity("1");
        flash("Unit added to this order.");
        await load();
      } else {
        const newOrder = await api<{ orderNumber: string; site: { id: string } }>(`/sites/${id}/clone-order`, {
          method: "POST",
          body: JSON.stringify({ productId: unitProductId, quantity }),
        });
        router.push(`/sites/${newOrder.site.id}`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to add unit");
    } finally {
      setAddingUnit(false);
    }
  }

  async function removeLineItem(lineItemId: string) {
    if (!site) return;
    setRemovingLineItemId(lineItemId);
    setError(null);
    try {
      await api(`/orders/${site.order.id}/line-items/${lineItemId}`, { method: "DELETE" });
      flash("Unit removed.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove unit");
    } finally {
      setRemovingLineItemId(null);
    }
  }

  async function createDriveFolders() {
    setCreatingDriveFolders(true);
    setError(null);
    try {
      await api(`/sites/${id}/drive-folders`, { method: "POST" });
      flash("Drive folders created.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create Drive folders");
    } finally {
      setCreatingDriveFolders(false);
    }
  }

  if (error && !site) return <p className="text-sm text-red-600">{error}</p>;
  if (!site) return <p className="text-sm text-gray-500">Loading...</p>;

  return (
    <div className="space-y-6 max-w-4xl" data-testid="site-detail-page">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold" style={{ color: "var(--text-heading)" }}>
          {site.companyName ?? "Unnamed site"}
        </h1>
        <p className="text-sm text-gray-500 font-mono text-xs">{site.order.orderNumber}</p>
        <p className="text-sm text-gray-500">
          {site.order.customer.name} · {site.address ?? "No address on file"}
        </p>
        <p className="text-sm text-gray-500">
          Current stage: <span className="font-medium">{site.currentStage.label}</span> ({site.currentStage.phase}) ·
          Engineer: {site.assignedEngineer?.name ?? "Unassigned"}
        </p>
        <p className="text-sm text-gray-500">
          Exhaust hookup - planned: {site.order.plannedExhaustHookupType ?? "-"}, confirmed:{" "}
          {site.confirmedExhaustHookupType ?? "awaiting confirmation"}
        </p>
        <p className="text-sm text-gray-500">
          Vendor: <span className="font-medium">{site.vendor?.name ?? "Unassigned"}</span>
        </p>
      </div>

      {banner && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2.5 text-sm text-emerald-800">{banner}</div>
      )}
      {error && site && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-700">{error}</div>}

      <section className="card p-5 space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Location</h2>
          {(() => {
            const url = mapsUrl(site.address, site.gpsLat, site.gpsLng);
            return url ? (
              <a href={url} target="_blank" rel="noreferrer" className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50">
                📍 View on Google Maps
              </a>
            ) : (
              <span className="text-xs text-gray-400">No location set yet</span>
            );
          })()}
        </div>
        {canEdit ? (
          <form onSubmit={submitLocation} className="space-y-2">
            <textarea
              placeholder="Site address"
              rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={locAddress}
              onChange={(e) => setLocAddress(e.target.value)}
            />
            <div className="grid grid-cols-2 gap-2">
              <input
                type="number"
                step="any"
                placeholder="Latitude"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                value={locLat}
                onChange={(e) => setLocLat(e.target.value)}
              />
              <input
                type="number"
                step="any"
                placeholder="Longitude"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                value={locLng}
                onChange={(e) => setLocLng(e.target.value)}
              />
            </div>
            <p className="text-[11px] text-gray-400">Coordinates give the most accurate map pin - paste them from a phone&apos;s GPS if available. Address alone still works for the map link.</p>
            <button type="submit" disabled={savingLocation} className="btn-primary px-4 py-2 text-sm">
              {savingLocation ? "Saving…" : "Save location"}
            </button>
          </form>
        ) : (
          <p className="text-sm text-gray-500 whitespace-pre-line">{site.address ?? "No address on file"}</p>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold">Site name</h2>
        <p className="text-xs text-gray-500">
          The end-client / site-owner who actually operates this premises - distinct from{" "}
          {site.order.customer.name}, who we&apos;re contracted with.
        </p>
        {canEdit ? (
          <form onSubmit={submitSiteDetails} className="space-y-2">
            <input
              placeholder="Site name (e.g. BPCL)"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={companyName}
              onChange={(e) => setCompanyName(e.target.value)}
            />
            <textarea
              placeholder="Site address"
              rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={detailsAddress}
              onChange={(e) => setDetailsAddress(e.target.value)}
            />
            <button type="submit" disabled={savingDetails} className="btn-primary px-4 py-2 text-sm">
              {savingDetails ? "Saving…" : "Save site details"}
            </button>
          </form>
        ) : (
          <p className="text-sm text-gray-500">{site.companyName ?? "No end-client name on file"}</p>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold">Site contacts</h2>
        <ul className="space-y-2">
          {site.contacts.map((c) => (
            <li key={c.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{c.name}</span>
                {c.role && <span className="text-gray-500"> · {c.role}</span>}
                {c.phone && <span className="text-gray-500"> · {c.phone}</span>}
                {c.email && <span className="text-gray-500"> · {c.email}</span>}
              </div>
              {canEdit && (
                <button type="button" onClick={() => removeContact(c.id)} className="text-xs text-red-600 hover:underline">
                  Remove
                </button>
              )}
            </li>
          ))}
          {site.contacts.length === 0 && <p className="text-sm text-gray-400">No contacts added yet.</p>}
        </ul>
        {canEdit && (
          <form onSubmit={addContact} className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <input
              placeholder="Name"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={contactName}
              onChange={(e) => setContactName(e.target.value)}
            />
            <input
              placeholder="Phone"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={contactPhone}
              onChange={(e) => setContactPhone(e.target.value)}
            />
            <input
              placeholder="Role (e.g. Security head)"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={contactRole}
              onChange={(e) => setContactRole(e.target.value)}
            />
            <button type="submit" disabled={addingContact} className="btn-primary px-4 py-2 text-sm sm:col-span-3">
              {addingContact ? "Adding…" : "+ Add contact"}
            </button>
          </form>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold">Document requirements</h2>
        <p className="text-xs text-gray-500">
          Safety/entry documents this site&apos;s end-client requires, e.g. police verification, ESIC, insurance, PPE kits.
        </p>
        {requirementTypes.length === 0 ? (
          <p className="text-sm text-gray-400">No requirement types configured yet.</p>
        ) : (
          <form onSubmit={saveDocumentRequirements} className="space-y-2">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-500">
                  <th className="py-1">Requirement</th>
                  <th className="py-1">Required</th>
                  <th className="py-1">Status</th>
                </tr>
              </thead>
              <tbody>
                {requirementTypes.map((t) => {
                  const state = requirementState[t.id] ?? { required: false, status: "not_submitted" };
                  return (
                    <tr key={t.id} className="border-t border-gray-100">
                      <td className="py-2">{t.label}</td>
                      <td className="py-2">
                        <input
                          type="checkbox"
                          checked={state.required}
                          disabled={!canEdit}
                          onChange={(e) =>
                            setRequirementState((prev) => ({ ...prev, [t.id]: { ...state, required: e.target.checked } }))
                          }
                        />
                      </td>
                      <td className="py-2">
                        <select
                          className="rounded-lg border border-gray-300 px-2 py-1 text-xs"
                          value={state.status}
                          disabled={!canEdit}
                          onChange={(e) => setRequirementState((prev) => ({ ...prev, [t.id]: { ...state, status: e.target.value } }))}
                        >
                          <option value="not_submitted">Not submitted</option>
                          <option value="submitted">Submitted</option>
                          <option value="verified">Verified</option>
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {canEdit && (
              <button type="submit" disabled={savingRequirements} className="btn-primary px-4 py-2 text-sm">
                {savingRequirements ? "Saving…" : "Save document requirements"}
              </button>
            )}
          </form>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold">RECD units</h2>
        <p className="text-xs text-gray-500">
          Every unit destined for this site. Add another one that ships under this same order
          (e.g. two different capacities delivered together), or as a fully separate order if
          it&apos;s commercially/logistically distinct - a separate site record with its own
          order number, sharing this site&apos;s address.
        </p>
        <ul className="space-y-2">
          <li className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm">
            <div>
              <span className="font-medium">{site.order.product.name} ({site.order.product.model})</span>
              <span className="text-gray-500"> · Qty {site.order.quantity}</span>
            </div>
            <span className="text-xs text-gray-400">Primary unit</span>
          </li>
          {site.order.lineItems.map((li) => (
            <li key={li.id} className="flex items-center justify-between rounded-lg border border-gray-200 px-3 py-2 text-sm">
              <div>
                <span className="font-medium">{li.product.name} ({li.product.model})</span>
                <span className="text-gray-500"> · Qty {li.quantity}</span>
              </div>
              {canManageOrders && (
                <button
                  type="button"
                  onClick={() => removeLineItem(li.id)}
                  disabled={removingLineItemId === li.id}
                  className="text-xs text-red-600 hover:underline disabled:opacity-50"
                >
                  {removingLineItemId === li.id ? "Removing…" : "Remove"}
                </button>
              )}
            </li>
          ))}
        </ul>
        {canManageOrders && (
          <form onSubmit={addUnit} className="space-y-2 pt-2 border-t border-gray-100">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <select
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                value={unitProductId}
                onChange={(e) => setUnitProductId(e.target.value)}
              >
                <option value="">Product</option>
                {products.map((p) => (
                  <option key={p.id} value={p.id}>{p.name} ({p.model})</option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                placeholder="Quantity"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
                value={unitQuantity}
                onChange={(e) => setUnitQuantity(e.target.value)}
              />
            </div>
            <div className="flex flex-col sm:flex-row gap-2 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" checked={unitMode === "same_order"} onChange={() => setUnitMode("same_order")} />
                Add to this order (ships together)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={unitMode === "separate_order"} onChange={() => setUnitMode("separate_order")} />
                Create as a separate order
              </label>
            </div>
            <button type="submit" disabled={addingUnit || !unitProductId} className="btn-primary px-4 py-2 text-sm disabled:opacity-50">
              {addingUnit ? "Adding…" : "+ Add another unit"}
            </button>
          </form>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold">RECD delivery</h2>
        {canEdit ? (
          <form onSubmit={saveDelivery} className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <select
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={deliveryProductId}
              onChange={(e) => setDeliveryProductId(e.target.value)}
            >
              <option value="">Product</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>{p.name} ({p.model})</option>
              ))}
            </select>
            <input
              type="number"
              min={1}
              placeholder="Quantity"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={deliveryQuantity}
              onChange={(e) => setDeliveryQuantity(e.target.value)}
            />
            <select
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={deliveryStatus}
              onChange={(e) => setDeliveryStatus(e.target.value)}
            >
              {DELIVERY_STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <input
              type="number"
              placeholder="Priority (lower = more urgent)"
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={deliveryPriority}
              onChange={(e) => setDeliveryPriority(e.target.value)}
            />
            <textarea
              placeholder="Status note (e.g. Delivery by 14-08-2026)"
              rows={2}
              className="sm:col-span-2 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={deliveryNote}
              onChange={(e) => setDeliveryNote(e.target.value)}
            />
            <button type="submit" disabled={savingDelivery} className="btn-primary px-4 py-2 text-sm sm:col-span-2">
              {savingDelivery ? "Saving…" : "Save delivery status"}
            </button>
          </form>
        ) : (
          <p className="text-sm text-gray-500">
            {site.recdDelivery
              ? `${site.recdDelivery.deliveryStatus} - ${site.recdDelivery.product?.name ?? ""}`
              : "No delivery recorded yet."}
          </p>
        )}
      </section>

      <section className="card p-5 space-y-3">
        <h2 className="text-sm font-semibold">Photographs &amp; drawings (Google Drive)</h2>
        {site.photosDriveFolderUrl || site.drawingsDriveFolderUrl ? (
          <div className="flex flex-wrap gap-3">
            {site.photosDriveFolderUrl && (
              <a
                href={site.photosDriveFolderUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                📁 Open Photographs folder
              </a>
            )}
            {site.drawingsDriveFolderUrl && (
              <a
                href={site.drawingsDriveFolderUrl}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
              >
                📁 Open Drawings folder
              </a>
            )}
          </div>
        ) : canEdit ? (
          <div className="space-y-2">
            <p className="text-xs text-gray-500">
              Creates a Photographs and a Drawings folder in the company Drive account for this site. Do this once.
            </p>
            <button
              type="button"
              onClick={createDriveFolders}
              disabled={creatingDriveFolders}
              className="btn-primary px-4 py-2 text-sm"
            >
              {creatingDriveFolders ? "Creating…" : "Create Drive folders"}
            </button>
          </div>
        ) : (
          <p className="text-sm text-gray-400">No Drive folders created yet.</p>
        )}
      </section>

      {canAssignVendor && (
        <section className="card p-5 space-y-3">
          <h2 className="text-sm font-semibold">Vendor assignment</h2>
          <p className="text-xs text-gray-500">
            Assign the external vendor responsible for erecting this site. Their engineers then see it; other vendors never will.
          </p>
          <form onSubmit={submitAssignVendor} className="flex flex-wrap items-center gap-3">
            <select
              className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={assignVendorId}
              onChange={(e) => setAssignVendorId(e.target.value)}
            >
              <option value="">Unassigned</option>
              {vendors.filter((v) => v.status === "approved").map((v) => (
                <option key={v.id} value={v.id}>{v.name}</option>
              ))}
            </select>
            <button type="submit" disabled={assigningVendor} className="btn-primary px-4 py-2 text-sm">
              {assigningVendor ? "Saving…" : "Assign vendor"}
            </button>
          </form>
        </section>
      )}

      {site.pendingActions.filter((p) => p.status === "open").length > 0 && (
        <section className="rounded-lg border border-amber-200 bg-amber-50 p-4">
          <h2 className="mb-2 text-sm font-medium text-amber-800">Open pending actions</h2>
          <ul className="space-y-1 text-sm text-amber-900">
            {site.pendingActions
              .filter((p) => p.status === "open")
              .map((p) => (
                <li key={p.id}>· {p.description}</li>
              ))}
          </ul>
        </section>
      )}

      {/* ── Field actions (only roles that can change site status) ──────────── */}
      {canEdit && (
        <section className="card p-5 space-y-4">
          <h2 className="text-sm font-semibold">Post a status update</h2>
          <form onSubmit={submitUpdate} className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Stage</label>
                <select
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  value={stageId}
                  onChange={(e) => setStageId(e.target.value)}
                >
                  {stages.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Status</label>
                <select
                  className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                  value={statusId}
                  onChange={(e) => setStatusId(e.target.value)}
                >
                  {statusOptions.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Comment</label>
              <textarea
                required
                rows={2}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                placeholder="What happened on site?"
                value={comment}
                onChange={(e) => setComment(e.target.value)}
              />
            </div>
            <button type="submit" disabled={submitting} className="btn-primary px-4 py-2 text-sm">
              {submitting ? "Posting…" : "Post update"}
            </button>
          </form>
        </section>
      )}

      {/* ── Exhaust hookup confirmation ─────────────────────────────────────── */}
      {canEdit && !site.confirmedExhaustHookupType && (
        <section className="card p-5 space-y-3">
          <h2 className="text-sm font-semibold">Confirm exhaust hookup</h2>
          <p className="text-xs text-gray-500">
            Confirm what works on site. If it doesn&apos;t match the sales plan, it&apos;s sent to the
            customer to decide (keep existing exhaust, or replace with the RECD).
          </p>
          <form onSubmit={submitExhaust} className="space-y-3">
            <select
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
              value={exhaustType}
              onChange={(e) => setExhaustType(e.target.value)}
            >
              {EXHAUST_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>{o.label}</option>
              ))}
            </select>
            <label className="flex items-center gap-2 text-sm text-gray-700">
              <input type="checkbox" checked={matchesPlan} onChange={(e) => setMatchesPlan(e.target.checked)} />
              This matches the planned hookup
            </label>
            <button type="submit" disabled={submittingExhaust} className="btn-primary px-4 py-2 text-sm">
              {submittingExhaust ? "Saving…" : "Confirm hookup"}
            </button>
          </form>
        </section>
      )}

      {/* ── Photo checkpoints ───────────────────────────────────────────────── */}
      {canEdit && checkpoints.length > 0 && (
        <section className="card p-5">
          <h2 className="text-sm font-semibold mb-3">Upload checkpoint photos</h2>
          <div className="flex flex-wrap gap-3">
            {checkpoints.map((c) => (
              <div key={c.id}>
                <input
                  ref={(el) => { photoInputRef.current[c.id] = el; }}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) uploadPhoto(c.id, f);
                    e.target.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => photoInputRef.current[c.id]?.click()}
                  disabled={uploadingCheckpoint === c.id}
                  className="rounded-lg border border-gray-300 px-3 py-2 text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  {uploadingCheckpoint === c.id ? "Uploading…" : `+ ${c.label}`}
                </button>
              </div>
            ))}
          </div>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-600">Stage timeline</h2>
        <ol className="space-y-3">
          {site.stageEvents.map((e) => (
            <li key={e.id} className="rounded-lg border border-gray-200 bg-white p-3 text-sm">
              <div className="font-medium">
                {e.stageDefinition.label} - {e.statusOption.label}
              </div>
              <div className="text-gray-600">{e.comment}</div>
              <div className="mt-1 text-xs text-gray-400">
                {e.createdBy.name} · {new Date(e.createdAt).toLocaleString()}
              </div>
            </li>
          ))}
          {site.stageEvents.length === 0 && <p className="text-sm text-gray-400">No updates yet.</p>}
        </ol>
      </section>

      <section>
        <h2 className="mb-2 text-sm font-medium text-gray-600">Photos</h2>
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
          {site.photos.map((p) => (
            <a key={p.id} href={p.photoUrl} target="_blank" rel="noreferrer" className="block">
              <img src={p.photoUrl} alt={p.checkpoint.label} className="h-24 w-full rounded object-cover" />
              <div className="mt-1 text-xs text-gray-500">{p.checkpoint.label}</div>
            </a>
          ))}
          {site.photos.length === 0 && <p className="text-sm text-gray-400">No photos uploaded yet.</p>}
        </div>
      </section>
    </div>
  );
}
