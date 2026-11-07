import type * as React from 'react';

export type IconName = 'theme' | 'mountain' | 'enemy' | 'target' | 'cube' | 'crosshair' | 'settings' | 'folder' | 'download'
  | 'undo' | 'redo' | 'bolt' | 'arrow' | 'expand' | 'play' | 'pause' | 'close';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** primary = tungsten, once per view. Default secondary. */
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  icon?: IconName | React.ReactNode;
  iconEnd?: IconName | React.ReactNode;
  /** Key hint in a mono kbd, e.g. "Space". */
  shortcut?: string;
}
export declare function Button(props: ButtonProps): React.ReactElement;

export interface IconProps { name: IconName; size?: number; title?: string; className?: string }
export declare function Icon(props: IconProps): React.ReactElement;

export interface MetaProps { items: React.ReactNode[]; tone?: 'tungsten' | 'peaking'; as?: string; className?: string }
export declare function Meta(props: MetaProps): React.ReactElement;

export interface TallyProps { state?: 'live' | 'ready' | 'warn' | 'idle'; children?: React.ReactNode; className?: string }
export declare function Tally(props: TallyProps): React.ReactElement;

export interface ViewfinderProps extends React.HTMLAttributes<HTMLElement> { active?: boolean; tone?: 'peaking' | 'tungsten'; as?: string }
export declare function Viewfinder(props: ViewfinderProps): React.ReactElement;

export interface WorldCardProps {
  title: string;
  /** Image URL of a real render (16:10) or a node. */
  art?: string | React.ReactNode;
  meta?: React.ReactNode[];
  status?: React.ReactNode;
  selected?: boolean;
  onSelect?: () => void;
  children?: React.ReactNode;
  className?: string;
}
export declare function WorldCard(props: WorldCardProps): React.ReactElement;

export interface SegmentedProps<T extends string = string> {
  options: { value: T; label: React.ReactNode }[];
  value?: T; defaultValue?: T; onChange?: (value: T) => void;
  label?: string; className?: string;
}
export declare function Segmented(props: SegmentedProps): React.ReactElement;

export interface TabsProps {
  items: { id: string; label: React.ReactNode; count?: number }[];
  value?: string; defaultValue?: string; onChange?: (id: string) => void;
  label?: string; className?: string;
}
export declare function Tabs(props: TabsProps): React.ReactElement;

export interface FieldProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label: string; hint?: string; error?: string; suffix?: React.ReactNode;
}
export declare function Field(props: FieldProps): React.ReactElement;

export interface NodePort { id?: string; label: string; type?: 'asset' | 'flow' | 'output'; connected?: boolean }
export interface NodeProps {
  title: string; kind?: string; icon?: IconName | React.ReactNode; status?: React.ReactNode;
  inputs?: NodePort[]; outputs?: NodePort[]; selected?: boolean; children?: React.ReactNode; className?: string;
}
export declare function Node(props: NodeProps): React.ReactElement;

export interface MeterProps {
  label: string; value: number; max?: number; display?: React.ReactNode;
  tone?: 'ink' | 'tungsten' | 'peaking' | 'zebra' | 'tally';
  /** At or under this value the meter turns tally and shows `flag`. */
  low?: number; flag?: string; className?: string;
}
export declare function Meter(props: MeterProps): React.ReactElement;

declare global {
  interface Window {
    Visigame: { Button: typeof Button; Icon: typeof Icon; Meta: typeof Meta; Tally: typeof Tally; Viewfinder: typeof Viewfinder;
      WorldCard: typeof WorldCard; Segmented: typeof Segmented; Tabs: typeof Tabs; Field: typeof Field; Node: typeof Node;
      Meter: typeof Meter; icons: IconName[] };
  }
}
