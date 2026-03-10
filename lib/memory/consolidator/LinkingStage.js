import { EmbeddingWorker } from "../EmbeddingWorker.js";

export class LinkingStage {
  constructor({
    embeddingWorkerFactory = () => new EmbeddingWorker(),
    graphLinkerFactory = async () => {
      const { GraphLinker } = await import("../GraphLinker.js");
      return new GraphLinker();
    }
  } = {}) {
    this.embeddingWorkerFactory = embeddingWorkerFactory;
    this.graphLinkerFactory = graphLinkerFactory;
  }

  async run() {
    const embeddingWorker = this.embeddingWorkerFactory();
    const embeddingsAdded = await embeddingWorker.processOrphanFragments(5);

    const linker = await this.graphLinkerFactory();
    const retroResult = await linker.retroLink(20);

    return {
      embeddingsAdded,
      retroLinked: retroResult.linksCreated
    };
  }
}
