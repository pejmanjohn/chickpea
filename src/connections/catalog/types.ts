import type { ToolInputSchema } from '@flue/runtime';
import type { ManagedCapabilitySemanticOverride } from '../../activity/semantic.ts';
export type ManagedAccessLane = 'read' | 'write';

export type ManagedEffectClass =
  | 'read'
  | 'reversible_write'
  | 'external_publish'
  | 'spend_or_budget'
  | 'destructive'
  | 'administrative';

export interface ManagedCapabilityDefinition {
  /** Stable Chickpea capability ID. */
  id: string;
  /** Toolkit that owns this capability. */
  connectorToolkit: string;
  accessLane: ManagedAccessLane;
  effect: ManagedEffectClass;
  toolName: string;
  description: string;
  input: ToolInputSchema;
  maxResultBytes: number;
  /** Optional closed grammar correction; never rendered copy. */
  semantic?: ManagedCapabilitySemanticOverride;
  /** Human-readable action checked by Chickpea's side-effect gate. */
  sideEffectLabel?: string;
  /** Conservative provider quota reservation made before remote dispatch. */
  quota?: readonly {
    bucket: string;
    units: number;
  }[];
  /** A workspace file Chickpea freezes and validates before provider staging. */
  artifact?: {
    argument: string;
    mimeTypeArgument: string;
    maxBytes: number;
    allowedMimeTypes: readonly string[];
  };
}

export interface ManagedResourceDefinition {
  /** Closed durable key used by account and Agent-binding policy. */
  key: string;
  label: string;
  required: boolean;
  multiple: boolean;
  /** Chickpea-local handle accepted by the Agent-facing tool. */
  localArgument: string;
  /** Provider argument populated only inside the execution adapter. */
  providerArgument: string;
}

export interface ManagedConnectorDefinition {
  id: string;
  toolkit: string;
  providerId: string;
  label: string;
  description: string;
  securityDescription: string;
  resources?: readonly ManagedResourceDefinition[];
  capabilities: readonly ManagedCapabilityDefinition[];
}

export type ManagedProviderAvailabilityStatus =
  | 'ready'
  | 'missing_configuration'
  | 'unavailable';

export type ManagedProviderConfigurationCode =
  | 'api_key_missing'
  | 'auth_config_missing'
  | 'provider_prerequisite_missing';

export interface ManagedProviderAvailability {
  status: ManagedProviderAvailabilityStatus;
  missingConfiguration: ManagedProviderConfigurationCode[];
}

export type {
  ManagedAccountResourceConstraints,
  ManagedBindingResourceConstraints,
  ManagedResourceSelection,
} from '../../config/types.ts';
