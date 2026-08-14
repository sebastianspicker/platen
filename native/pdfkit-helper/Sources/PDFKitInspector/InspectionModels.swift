import Foundation

struct ProtectionStructureSummary: Encodable, Equatable {
    let pageRotations: [Int]
    let annotationCounts: [Int]
    let annotationSubtypes: [[String]]
}

struct InspectionResult: Encodable {
    let document: DocumentInventory
    let metadata: MetadataInventory
    let pages: [PageInventory]
    let pagesTruncated: Bool
    let outline: OutlineInventory
    let pageLabels: PageLabelsInventory
    let optionalContent: OptionalContentInventory
}

struct DocumentInventory: Encodable {
    let pageCount: Int
    let encrypted: Bool
    let locked: Bool
    let permissions: Permissions
    let supportedAnnotationTypes: [String]
}

struct Permissions: Encodable {
    let copying: Bool
    let printing: Bool
    let changes: Bool
    let commenting: Bool
    let formFieldEntry: Bool
    let assembly: Bool
    let contentAccessibility: Bool
    let status: String
}

struct MetadataInventory: Encodable, Equatable {
    let title: String?
    let author: String?
    let subject: String?
    let creator: String?
    let producer: String?
    let creationDate: String?
    let modificationDate: String?
    let keywords: String?

    private enum CodingKeys: String, CodingKey {
        case title, author, subject, creator, producer, creationDate, modificationDate, keywords
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try Self.encode(title, forKey: .title, into: &container)
        try Self.encode(author, forKey: .author, into: &container)
        try Self.encode(subject, forKey: .subject, into: &container)
        try Self.encode(creator, forKey: .creator, into: &container)
        try Self.encode(producer, forKey: .producer, into: &container)
        try Self.encode(creationDate, forKey: .creationDate, into: &container)
        try Self.encode(modificationDate, forKey: .modificationDate, into: &container)
        try Self.encode(keywords, forKey: .keywords, into: &container)
    }

    private static func encode(
        _ value: String?,
        forKey key: CodingKeys,
        into container: inout KeyedEncodingContainer<CodingKeys>
    ) throws {
        if let value { try container.encode(value, forKey: key) }
        else { try container.encodeNil(forKey: key) }
    }
}

struct PageInventory: Encodable {
    let index: Int
    let label: String
    let rotation: Int
    let boxes: PageBoxes
    let annotations: [AnnotationInventory]
    let annotationsTruncated: Bool
    let widgets: [WidgetInventory]
    let widgetsTruncated: Bool
    let links: [LinkInventory]
    let linksTruncated: Bool
}

struct PageBoxes: Encodable, Equatable {
    let media: Rectangle
    let crop: Rectangle
    let bleed: Rectangle
    let trim: Rectangle
    let art: Rectangle
}

struct Rectangle: Encodable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct AnnotationInventory: Encodable {
    let subtype: String
    let annotationIndex: Int
    let fingerprint: String
}

struct WidgetInventory: Encodable {
    let fieldName: String?
    let fieldType: String
    let controlKind: String?
    let flags: Int
    let annotationIndex: Int
    let fingerprint: String

    private enum CodingKeys: String, CodingKey { case fieldName, fieldType, controlKind, flags, annotationIndex, fingerprint }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let fieldName { try container.encode(fieldName, forKey: .fieldName) }
        else { try container.encodeNil(forKey: .fieldName) }
        try container.encode(fieldType, forKey: .fieldType)
        if let controlKind { try container.encode(controlKind, forKey: .controlKind) }
        else { try container.encodeNil(forKey: .controlKind) }
        try container.encode(flags, forKey: .flags)
        try container.encode(annotationIndex, forKey: .annotationIndex)
        try container.encode(fingerprint, forKey: .fingerprint)
    }
}

struct LinkInventory: Encodable {
    let annotationIndex: Int
    let rect: Rectangle
    let kind: String
    let targetPage: Int?
    let target: String?
    let remotePage: Int?

    private enum CodingKeys: String, CodingKey { case annotationIndex, rect, kind, targetPage, target, remotePage }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(annotationIndex, forKey: .annotationIndex)
        try container.encode(rect, forKey: .rect)
        try container.encode(kind, forKey: .kind)
        if let targetPage { try container.encode(targetPage, forKey: .targetPage) }
        else { try container.encodeNil(forKey: .targetPage) }
        if let target { try container.encode(target, forKey: .target) }
        else { try container.encodeNil(forKey: .target) }
        if let remotePage { try container.encode(remotePage, forKey: .remotePage) }
        else { try container.encodeNil(forKey: .remotePage) }
    }
}

struct PageLabelsInventory: Encodable {
    let present: Bool
    let items: [PageLabelItem]
    let truncated: Bool
}

struct PageLabelItem: Encodable {
    let page: Int
    let label: String
}

struct OptionalContentInventory: Encodable {
    let present: Bool
    let groupCount: Int
    let groups: [OptionalContentGroup]
    let groupsTruncated: Bool
    let defaultConfigurationPresent: Bool
}

struct OptionalContentGroup: Encodable {
    let index: Int
    let name: String?
    let defaultVisible: Bool?

    private enum CodingKeys: String, CodingKey { case index, name, defaultVisible }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(index, forKey: .index)
        if let name { try container.encode(name, forKey: .name) }
        else { try container.encodeNil(forKey: .name) }
        if let defaultVisible { try container.encode(defaultVisible, forKey: .defaultVisible) }
        else { try container.encodeNil(forKey: .defaultVisible) }
    }
}

struct OutlineInventory: Encodable, Equatable {
    let items: [OutlineItem]
    let truncated: Bool
}

struct OutlineItem: Encodable, Equatable {
    let title: String?
    let page: Int?
    let children: [OutlineItem]
    let removalLocator: OutlineRemovalLocator?

    private enum CodingKeys: String, CodingKey { case title, page, children, removalLocator }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        if let title { try container.encode(title, forKey: .title) }
        else { try container.encodeNil(forKey: .title) }
        if let page { try container.encode(page, forKey: .page) }
        else { try container.encodeNil(forKey: .page) }
        try container.encode(children, forKey: .children)
        if let removalLocator { try container.encode(removalLocator, forKey: .removalLocator) }
        else { try container.encodeNil(forKey: .removalLocator) }
    }
}
