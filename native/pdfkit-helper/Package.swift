// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "PDFKitInspector",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "pdfkit-inspect", targets: ["PDFKitInspector"]),
        .executable(name: "pdf-signature-trust", targets: ["PDFSignatureTrust"]),
        .executable(name: "pdf-signing-identity", targets: ["PDFSigningIdentity"]),
        .executable(name: "pdf-scanner-acquisition", targets: ["PDFScannerAcquisition"]),
    ],
    targets: [
        .target(name: "PDFScannerAcquisitionCore"),
        .executableTarget(
            name: "PDFScannerAcquisition",
            dependencies: ["PDFScannerAcquisitionCore"],
            linkerSettings: [
                .linkedFramework("ImageCaptureCore"),
                .linkedFramework("ImageIO"),
                .linkedFramework("CoreGraphics"),
            ]
        ),
        .executableTarget(
            name: "PDFKitInspector",
            linkerSettings: [.linkedFramework("PDFKit")]
        ),
        .executableTarget(
            name: "PDFSignatureTrust",
            linkerSettings: [.linkedFramework("Security")]
        ),
        .executableTarget(
            name: "PDFSigningIdentity",
            linkerSettings: [
                .linkedFramework("Foundation"),
                .linkedFramework("Security"),
            ]
        ),
        .testTarget(
            name: "PDFScannerAcquisitionCoreTests",
            dependencies: ["PDFScannerAcquisitionCore"]
        ),
    ]
)
