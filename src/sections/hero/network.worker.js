/**
 * Builds the hero's neural network off the main thread.
 * In:  { id, nodes, metros, maxTheta, poses }   Out: { id, net }
 */
import { buildNetwork, createKeep, transferablesOf } from './network.js'

self.onmessage = ({ data }) => {
  const { id, poses, ...options } = data
  const net = buildNetwork({ ...options, keep: createKeep(poses) })
  self.postMessage({ id, net }, transferablesOf(net))
}
