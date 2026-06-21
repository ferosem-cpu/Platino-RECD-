export interface StageDefinitionDTO {
  id: string;
  key: string;
  label: string;
  phase: string;
  sequenceOrder: number;
}

export interface StatusOptionDTO {
  id: string;
  key: string;
  label: string;
  requiresComment: boolean;
}

export interface PhotoCheckpointDTO {
  id: string;
  key: string;
  label: string;
  sequenceOrder: number;
}

export interface SiteStageEventDTO {
  id: string;
  siteId: string;
  stageDefinition: StageDefinitionDTO;
  statusOption: StatusOptionDTO;
  comment: string;
  photoUrl?: string | null;
  createdByName: string;
  createdAt: string;
}

export interface SitePhotoDTO {
  id: string;
  checkpoint: PhotoCheckpointDTO;
  photoUrl: string;
  caption?: string | null;
  uploadedByName: string;
  uploadedAt: string;
}

export interface SiteSummaryDTO {
  id: string;
  orderId: string;
  customerName: string;
  siteAddress: string;
  currentStage: StageDefinitionDTO;
  assignedEngineerName?: string | null;
  lastUpdatedAt: string;
}

export interface SiteDetailDTO extends SiteSummaryDTO {
  stageHistory: SiteStageEventDTO[];
  photos: SitePhotoDTO[];
  plannedExhaustHookupType?: string | null;
  confirmedExhaustHookupType?: string | null;
}

export interface DashboardCountsDTO {
  sitesByPhase: Record<string, number>;
  complaintsByStatus: Record<string, number>;
}
