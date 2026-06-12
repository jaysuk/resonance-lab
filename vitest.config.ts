import vue from "@vitejs/plugin-vue";
import { dwcVitestConfig } from "dwc-plugin-test-kit/vitest";

export default dwcVitestConfig({ plugins: [vue()] });
