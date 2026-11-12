/**
 * The suite runs on machines whose disks are whatever they are: every
 * default disk reading (vitals, the disk floor of #10850) sees a roomy one,
 * so no test is refused by the machine it ran on, and a test of a full disk
 * gives its own reading. The preload imports it; so does every helper the
 * suite starts as a process of its own (`real-child-forge.ts` and the like),
 * which no preload reaches: a check host near 15% free must not refuse the
 * child a cell test boots.
 */
import { provideDiskForTest } from "../../src/kernel/disk_reading.ts";

provideDiskForTest(() => ({ freeBytes: 900 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3 }));
