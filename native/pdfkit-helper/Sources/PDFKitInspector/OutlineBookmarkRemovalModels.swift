import Foundation

struct OutlineRemovalLocator: Encodable, Equatable {
    let topLevelIndex: Int
    let fingerprint: String
}

struct OutlineRemovalDestination: Equatable {
    let page: Int
    let mode: String
    let x: Double?
    let y: Double?

    var semanticTuple: String {
        var lines = ["page=\(page)", "mode=\(mode)"]
        if let x { lines.append("x=\(x)") }
        if let y { lines.append("y=\(y)") }
        return lines.joined(separator: "\n")
    }
}

struct OutlineRemovalNode: Equatable {
    let label: String
    let labelSHA256: String
    let isOpen: Bool
    let destination: OutlineRemovalDestination
    let children: [OutlineRemovalNode]
}

struct OutlineRemovalBlueprint: Equatable {
    let nodes: [OutlineRemovalNode]
    let itemCount: Int

    func locator(sourceDigest: String, topLevelIndex: Int) -> OutlineRemovalLocator? {
        guard topLevelIndex >= 0,
              topLevelIndex < nodes.count,
              nodes[topLevelIndex].children.isEmpty
        else { return nil }
        let node = nodes[topLevelIndex]
        let descriptor = [
            "pdfkit-inspector:outline-removal:v1",
            "source-sha256=\(sourceDigest)",
            "top-level-index=\(topLevelIndex)",
            "label-sha256=\(node.labelSHA256)",
            node.destination.semanticTuple,
            "child-count=\(node.children.count)",
        ].joined(separator: "\n")
        return OutlineRemovalLocator(
            topLevelIndex: topLevelIndex,
            fingerprint: sha256Hex(Data(descriptor.utf8))
        )
    }
}

struct OutlineMutationSnapshot: Equatable {
    let pageCount: Int
    let pageBoxes: [PageBoxes]
    let pageRotations: [Int]
    let annotationDescriptors: [[CropAnnotationDescriptor]]
    let textSHA256: [String]
    let renderSHA256: [String]
    let metadata: MetadataInventory
    let outline: OutlineRemovalBlueprint
}
