export function evaluateCorpusCriteria (workloads, settings) {
    const eligible = workloads.length > 0 &&
        settings.pairs >= 5 && settings.samples >= 20 && settings.warmup >= 3;
    const measurementsPass = workloads.every(item =>
        Number.isFinite(item.syntrix?.medianMs) && item.syntrix.medianMs > 0 &&
        item.syntrix.p95Ms >= item.syntrix.medianMs &&
        item.syntrix.coldConstructionMs > 0 &&
        item.syntrix.firstParseMs > 0 &&
        item.syntrix.sampledPeakRssBytes > 0 &&
        item.syntrix.sampledPeakHeapBytes > 0 &&
        item.syntrix.retainedHeapBytes > 0
    );
    return {
        status: !eligible ? 'insufficient' : measurementsPass ? 'pass' : 'fail',
        totalWorkloads: workloads.length,
        measurementsPass
    };
}
