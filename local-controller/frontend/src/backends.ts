// 6 accelerator backends for live $/prediction comparison.
//
// Each backend exposes /api/predict and /api/ready. The frontend fans out
// a single protein to all 6 in parallel and tabulates cost + time.
//
// pricePerSec is the on-demand price of one accelerator, the smallest machine that runs each job, from
// the Cloud Billing Catalog API (2026-10-31). Each TPU job uses one chip.
//   TPU v5e (ESMFold, AF2):     1 chip × $1.20/chip-hr ÷ 3600 = $0.000333/sec
//   TPU v6e (Boltz-2):          1 chip × $2.70/chip-hr ÷ 3600 = $0.000750/sec
//   A100 40GB (a2-highgpu-1g):  $3.673385/hr ÷ 3600           = $0.001020/sec

import type { BackendId, ModelId, SiliconId } from './types'

export interface AcceleratorBackend {
  id: BackendId
  modelId: ModelId
  siliconId: SiliconId
  label: string
  shortLabel: string
  modelName: string
  siliconName: string
  apiBase: string
  pricePerSec: number
  accent: string
  talkTrackSlide: number
  talkTrackLabel: string
  blurb: string
}

export const BACKENDS: AcceleratorBackend[] = [
  {
    id: 'af2-tpu',
    modelId: 'af2',
    siliconId: 'tpu',
    label: 'AlphaFold 2 — TPU v5e',
    shortLabel: 'AF2 · TPU',
    modelName: 'AlphaFold 2',
    siliconName: 'TPU v5e',
    apiBase: '', // will be set at deploy time
    pricePerSec: 0.000333,
    accent: 'border-emerald-400/60',
    talkTrackSlide: 11,
    talkTrackLabel: 'AlphaFold on TPU — Biowulf runs this on A100s',
    blurb: 'v5e-4 on demand, one chip per job — JAX/Haiku native',
  },
  {
    id: 'af2-gpu',
    modelId: 'af2',
    siliconId: 'gpu',
    label: 'AlphaFold 2 — GPU A100',
    shortLabel: 'AF2 · GPU',
    modelName: 'AlphaFold 2',
    siliconName: 'A100 40GB',
    apiBase: '',
    pricePerSec: 0.00102,
    accent: 'border-amber-400/60',
    talkTrackSlide: 3,
    talkTrackLabel: 'NVIDIA on Google Cloud — Cloud RDMA + Falcon',
    blurb: 'A100 40GB on demand — FoldRun pipeline',
  },
  {
    id: 'esmfold-tpu',
    modelId: 'esmfold',
    siliconId: 'tpu',
    label: 'ESMFold — TPU v5e (TorchTPU)',
    shortLabel: 'ESMFold · TPU',
    modelName: 'ESMFold',
    siliconName: 'TPU v5e',
    apiBase: '',
    pricePerSec: 0.000333,
    accent: 'border-cyan-400/60',
    talkTrackSlide: 12,
    talkTrackLabel: 'TorchTPU — existing PyTorch code, device=\'tpu\'',
    blurb: 'v5e-4 on demand, one chip per job — PyTorch via torch_xla (validates Slide 12)',
  },
  {
    id: 'esmfold-gpu',
    modelId: 'esmfold',
    siliconId: 'gpu',
    label: 'ESMFold — GPU A100',
    shortLabel: 'ESMFold · GPU',
    modelName: 'ESMFold',
    siliconName: 'A100 40GB',
    apiBase: '',
    pricePerSec: 0.00102,
    accent: 'border-orange-400/60',
    talkTrackSlide: 15,
    talkTrackLabel: 'AI Models — ESMFold (2.1M downloads, MIT)',
    blurb: 'A100 40GB on demand — HuggingFace transformers',
  },
  {
    id: 'boltz2-tpu',
    modelId: 'boltz2',
    siliconId: 'tpu',
    label: 'Boltz-2 — TPU v6e (TorchTPU)',
    shortLabel: 'Boltz-2 · TPU',
    modelName: 'Boltz-2',
    siliconName: 'TPU v6e',
    apiBase: '',
    pricePerSec: 0.00075,
    accent: 'border-violet-400/60',
    talkTrackSlide: 12,
    talkTrackLabel: 'TorchTPU — PyTorch diffusion model on TPU',
    blurb: 'v6e-4 on demand, one chip per job — proteins + RNA + DNA + ligands',
  },
  {
    id: 'boltz2-gpu',
    modelId: 'boltz2',
    siliconId: 'gpu',
    label: 'Boltz-2 — GPU A100',
    shortLabel: 'Boltz-2 · GPU',
    modelName: 'Boltz-2',
    siliconName: 'A100 40GB',
    apiBase: '',
    pricePerSec: 0.00102,
    accent: 'border-rose-400/60',
    talkTrackSlide: 15,
    talkTrackLabel: 'Proteins + RNA + DNA + ligands — open model',
    blurb: 'A100 40GB on demand — Boltz-2 (MIT license)',
  },
]

export function getBackend(id: BackendId): AcceleratorBackend {
  return BACKENDS.find(b => b.id === id)!
}

export function getBackendsByModel(modelId: ModelId): AcceleratorBackend[] {
  return BACKENDS.filter(b => b.modelId === modelId)
}

export function getBackendsBySilicon(siliconId: SiliconId): AcceleratorBackend[] {
  return BACKENDS.filter(b => b.siliconId === siliconId)
}
